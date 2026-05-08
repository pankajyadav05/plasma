import { type Server, createServer } from 'node:net';
import type { Settings } from '@shared/protocol';
import { Client as SshClient } from 'ssh2';
import { logger } from './logger';

/**
 * SSH tunnel manager. One tunnel per connection id. When a worker
 * connect is requested for a tagged connection, we:
 *   1. Open an ssh2 connection to the bastion
 *   2. Bind a local TCP server on a random port
 *   3. For each accepted local socket, ask ssh2 to `forwardOut` to the
 *      target host/port and pipe the streams together
 *   4. Hand back the local port — main then rewrites the worker's
 *      connect config to point at `127.0.0.1:<localPort>`
 *
 * Tunnel teardown closes both the local server AND the ssh client so a
 * disconnect leaves no dangling sockets.
 */

type TunnelKey = string;

interface OpenTunnel {
  server: Server;
  ssh: SshClient;
  localPort: number;
  refs: number;
}

const tunnels = new Map<TunnelKey, OpenTunnel>();

export type SshConfig = NonNullable<Settings['connectionSsh']>[string];

export interface TunnelTarget {
  /** Connection id (for cache keying + ref counting). */
  id: string;
  /** SSH bastion config. */
  ssh: SshConfig;
  /** Postgres host as seen from the bastion (often localhost there). */
  pgHost: string;
  pgPort: number;
}

export async function openTunnel(target: TunnelTarget): Promise<{ host: string; port: number }> {
  const cached = tunnels.get(target.id);
  if (cached) {
    cached.refs++;
    return { host: '127.0.0.1', port: cached.localPort };
  }

  const ssh = new SshClient();
  await new Promise<void>((resolve, reject) => {
    ssh.once('ready', resolve);
    ssh.once('error', reject);
    const opts: Parameters<typeof ssh.connect>[0] = {
      host: target.ssh.host,
      port: target.ssh.port,
      username: target.ssh.user,
      readyTimeout: 15_000,
    };
    if (target.ssh.privateKey) {
      opts.privateKey = target.ssh.privateKey;
      if (target.ssh.passphrase) opts.passphrase = target.ssh.passphrase;
    } else if (target.ssh.password) {
      opts.password = target.ssh.password;
    }
    ssh.connect(opts);
  });

  const server = createServer((local) => {
    ssh.forwardOut('127.0.0.1', 0, target.pgHost, target.pgPort, (err, stream) => {
      if (err) {
        logger.error('[plasma-ssh] forwardOut failed:', err);
        local.destroy();
        return;
      }
      local.pipe(stream).pipe(local);
      stream.on('error', (e: Error) => {
        logger.error('[plasma-ssh] tunnel stream error:', e);
        local.destroy();
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Port 0 = OS picks a free one. Bind to 127.0.0.1 only — never
    // expose the tunnel to the network.
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('ssh tunnel: failed to bind local port');
  }

  tunnels.set(target.id, {
    server,
    ssh,
    localPort: addr.port,
    refs: 1,
  });

  logger.info(
    '[plasma-ssh] tunnel open',
    target.id,
    `127.0.0.1:${addr.port} -> ${target.ssh.host}:${target.ssh.port} -> ${target.pgHost}:${target.pgPort}`,
  );

  ssh.on('close', () => {
    logger.info('[plasma-ssh] ssh client closed', target.id);
    tunnels.delete(target.id);
    try {
      server.close();
    } catch {
      // already closed
    }
  });

  return { host: '127.0.0.1', port: addr.port };
}

export function closeTunnel(id: string): void {
  const t = tunnels.get(id);
  if (!t) return;
  t.refs--;
  if (t.refs > 0) return;
  tunnels.delete(id);
  try {
    t.server.close();
  } catch {
    // best-effort
  }
  try {
    t.ssh.end();
  } catch {
    // best-effort
  }
  logger.info('[plasma-ssh] tunnel closed', id);
}

export function closeAllTunnels(): void {
  for (const id of [...tunnels.keys()]) {
    closeTunnel(id);
  }
}
