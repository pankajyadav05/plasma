import { type Server, createServer } from 'node:net';
import { SettingsShape, type Settings } from '@shared/protocol';
import { Client as SshClient } from 'ssh2';
import { logger } from './logger';
import { getAllSettings, setSetting } from './settings';
import {
  evaluateHostKey,
  type KnownHostsStore,
  rememberHostKey,
} from './ssh-known-hosts';

/**
 * SSH tunnel manager. One tunnel per connection id. When a worker
 * connect is requested for a tagged connection, we:
 *   1. Open an ssh2 connection to the bastion (with host-key verification)
 *   2. Bind a local TCP server on a random port
 *   3. For each accepted local socket, ask ssh2 to `forwardOut` to the
 *      target host/port and pipe the streams together
 *   4. Hand back the local port — main then rewrites the worker's
 *      connect config to point at `127.0.0.1:<localPort>`
 *
 * Tunnel teardown closes both the local server AND the ssh client so a
 * disconnect leaves no dangling sockets.
 *
 * U08: host keys are checked against the `sshKnownHosts` settings store.
 * First use prompts via `hostKeyPrompt` (TOFU); mismatches refuse.
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

export type HostKeyPrompt = (info: {
  host: string;
  port: number;
  fingerprint: string;
}) => Promise<boolean>;

/** Injected from main so unit tests / non-Electron callers can stub prompts. */
let hostKeyPrompt: HostKeyPrompt = async () => false;

export function setHostKeyPrompt(fn: HostKeyPrompt): void {
  hostKeyPrompt = fn;
}

function loadKnownHosts(): KnownHostsStore {
  return SettingsShape.parse(getAllSettings()).sshKnownHosts ?? {};
}

function persistKnownHosts(store: KnownHostsStore): void {
  setSetting('sshKnownHosts', store);
}

function attachHostVerifier(
  opts: Parameters<SshClient['connect']>[0],
  host: string,
  port: number,
): void {
  opts.hostVerifier = (key: Buffer, verify: (valid: boolean) => void) => {
    void (async () => {
      try {
        const store = loadKnownHosts();
        const decision = evaluateHostKey(store, host, port, key);
        if (decision.kind === 'match') {
          verify(true);
          return;
        }
        if (decision.kind === 'mismatch') {
          logger.error(
            '[plasma-ssh] host key mismatch',
            `${host}:${port}`,
            'presented',
            decision.fingerprint,
            'expected',
            decision.expectedFingerprint,
          );
          verify(false);
          return;
        }
        // First use — prompt, then remember on accept.
        const ok = await hostKeyPrompt({
          host,
          port,
          fingerprint: decision.fingerprint,
        });
        if (!ok) {
          verify(false);
          return;
        }
        persistKnownHosts(rememberHostKey(store, host, port, key));
        logger.info('[plasma-ssh] remembered host key', `${host}:${port}`, decision.fingerprint);
        verify(true);
      } catch (err) {
        logger.error('[plasma-ssh] hostVerifier failed:', err);
        verify(false);
      }
    })();
  };
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
    attachHostVerifier(opts, target.ssh.host, target.ssh.port);
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
