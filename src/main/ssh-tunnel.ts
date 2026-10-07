import { readFileSync } from 'node:fs';
import { type Server, type Socket, createServer } from 'node:net';
import { pipeline } from 'node:stream';
import { type Settings, SettingsShape } from '@shared/protocol';
import { Client as SshClient } from 'ssh2';
import { logger } from './logger';
import { getAllSettings, setSetting } from './settings';
import { buildSshAuthOptions } from './ssh-auth';
import {
  type KnownHostsStore,
  evaluateHostKey,
  hostKeyType,
  rememberHostKey,
} from './ssh-known-hosts';

/**
 * SSH tunnel manager. One tunnel per key (normally the connection id).
 * When a worker connect is requested for a tagged connection, we:
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
 * U08 / C8: host keys are checked against the `sshKnownHosts` settings
 * store. Unknown keys and changed keys both go to `hostKeyPrompt`
 * (changed ones with a strong warning); nothing connects without a yes.
 *
 * C6 / C13 / C14: every socket, stream, server and ssh client has an
 * error listener (an unhandled one crashes main); there is exactly one
 * tunnel per key with no ref counting; a late 'close' from a replaced
 * client can't evict its successor; concurrent opens share one attempt;
 * failures clean up after themselves; and keepalives detect a dead
 * bastion so queries don't hang on it.
 */

type TunnelKey = string;

interface OpenTunnel {
  server: Server;
  ssh: SshClient;
  localPort: number;
  /** Local sockets currently forwarded, so close() can drop them. */
  sockets: Set<Socket>;
  /** Target identity — a changed target must not reuse this tunnel. */
  signature: string;
}

const tunnels = new Map<TunnelKey, OpenTunnel>();
/** Why the jump host last failed to open the database port, per tunnel id (read by the connection error). */
const forwardErrors = new Map<TunnelKey, string>();
const opening = new Map<
  TunnelKey,
  { promise: Promise<{ host: string; port: number }>; signature: string }
>();
/** Ids closed while their open was still in flight. */
const cancelled = new Set<TunnelKey>();

type SavedSsh = NonNullable<Settings['connectionSsh']>[string];
export type SshConfig = Omit<SavedSsh, 'privateKeyPath' | 'useAgent'> & {
  privateKeyPath?: string;
  useAgent?: boolean;
};

export interface TunnelTarget {
  /** Cache key — the connection id, or a throwaway key for tests. */
  id: string;
  /** SSH bastion config. */
  ssh: SshConfig;
  /** Database host as seen from the bastion (often localhost there). */
  pgHost: string;
  pgPort: number;
}

export type HostKeyPrompt = (info: {
  host: string;
  port: number;
  fingerprint: string;
  /** `changed`: the host presented a different key than the remembered one. */
  kind: 'unknown' | 'changed';
  expectedFingerprint?: string;
}) => Promise<boolean>;

/** Injected from main so unit tests / non-Electron callers can stub prompts. */
let hostKeyPrompt: HostKeyPrompt = async () => false;

export function setHostKeyPrompt(fn: HostKeyPrompt): void {
  hostKeyPrompt = fn;
}

/**
 * SC-17: how long the user gets to compare a host-key fingerprint. ssh2's
 * `readyTimeout` also covers the async hostVerifier, so it must outlast this
 * (plus authentication); reaching an unreachable host is bounded separately
 * by SSH_CONNECT_TIMEOUT_MS, which stops once the server presents its key.
 */
export const HOST_KEY_PROMPT_TIMEOUT_MS = 50_000;
export const SSH_CONNECT_TIMEOUT_MS = 15_000;
export const SSH_READY_TIMEOUT_MS = HOST_KEY_PROMPT_TIMEOUT_MS + 40_000;

/** ssh2 keepalive: probe every 10s, give up after 3 missed replies (C14). */
export const SSH_KEEPALIVE_INTERVAL_MS = 10_000;
export const SSH_KEEPALIVE_COUNT_MAX = 3;

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
  hooks: {
    onReached: () => void;
    isLive: () => boolean;
    /** The key was refused (by the user, or the prompt timed out): was it new or changed? */
    onRejected: (kind: 'changed' | 'unknown') => void;
  },
): void {
  opts.hostVerifier = (key: Buffer, verify: (valid: boolean) => void) => {
    // The server answered: the connect timer's job is done.
    hooks.onReached();
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
        }
        const ok = await hostKeyPrompt(
          decision.kind === 'mismatch'
            ? {
                host,
                port,
                fingerprint: decision.fingerprint,
                kind: 'changed',
                expectedFingerprint: decision.expectedFingerprint,
              }
            : { host, port, fingerprint: decision.fingerprint, kind: 'unknown' },
        );
        if (!ok || !hooks.isLive()) {
          // Also covers an Accept that arrives after the attempt already
          // failed: remembering a key for a dead connection would trust it later.
          hooks.onRejected(decision.kind === 'mismatch' ? 'changed' : 'unknown');
          verify(false);
          return;
        }
        // Re-read: another prompt may have written meanwhile.
        persistKnownHosts(rememberHostKey(loadKnownHosts(), host, port, key, hostKeyType(key)));
        logger.info('[plasma-ssh] remembered host key', `${host}:${port}`, decision.fingerprint);
        verify(true);
      } catch (err) {
        logger.error('[plasma-ssh] hostVerifier failed:', err);
        verify(false);
      }
    })();
  };
}

function signatureOf(target: TunnelTarget): string {
  const { ssh } = target;
  return `${ssh.user}@${ssh.host}:${ssh.port}->${target.pgHost}:${target.pgPort}`;
}

function destroyTunnel(id: string, t: OpenTunnel, reason: string): void {
  if (tunnels.get(id) === t) tunnels.delete(id);
  forwardErrors.delete(id);
  for (const socket of t.sockets) socket.destroy();
  t.sockets.clear();
  try {
    t.server.close();
  } catch {
    // already closed
  }
  try {
    t.ssh.end();
  } catch {
    // already closed
  }
  logger.info('[plasma-ssh] tunnel closed', id, reason);
}

async function connectSsh(target: TunnelTarget): Promise<SshClient> {
  const ssh = new SshClient();
  // C6: a persistent listener — ssh2 can emit more than one error, and
  // any error without a listener is an uncaught exception in main.
  ssh.on('error', (err: Error) => {
    logger.error('[plasma-ssh] ssh client error', target.id, err.message);
  });
  let live = true;
  let rejectedKey: 'changed' | 'unknown' | undefined;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const onReady = () => {
        ssh.removeListener('error', onError);
        resolve();
      };
      const onError = (err: Error) => {
        ssh.removeListener('ready', onReady);
        reject(err);
      };
      connectTimer = setTimeout(() => {
        ssh.removeListener('ready', onReady);
        ssh.removeListener('error', onError);
        reject(new Error('Timed out while waiting for handshake'));
      }, SSH_CONNECT_TIMEOUT_MS);
      ssh.once('ready', onReady);
      ssh.once('error', onError);
      const opts: Parameters<typeof ssh.connect>[0] = {
        host: target.ssh.host,
        port: target.ssh.port,
        username: target.ssh.user,
        readyTimeout: SSH_READY_TIMEOUT_MS,
        keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
        keepaliveCountMax: SSH_KEEPALIVE_COUNT_MAX,
      };
      attachHostVerifier(opts, target.ssh.host, target.ssh.port, {
        onReached: () => clearTimeout(connectTimer),
        isLive: () => live,
        onRejected: (kind) => {
          rejectedKey = kind;
        },
      });
      try {
        Object.assign(
          opts,
          buildSshAuthOptions(target.ssh, {
            readFile: (path) => readFileSync(path),
            env: process.env,
            platform: process.platform,
          }),
        );
      } catch (err) {
        reject(err);
        return;
      }
      ssh.connect(opts);
    });
  } catch (err) {
    live = false;
    try {
      ssh.end();
    } catch {
      // best-effort
    }
    // Say where it failed, so the connection error can talk about the jump host.
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
      source: 'ssh' as const,
      ...(rejectedKey ? { hostKey: rejectedKey } : {}),
    });
  } finally {
    clearTimeout(connectTimer);
  }
  return ssh;
}

async function createTunnel(target: TunnelTarget): Promise<{ host: string; port: number }> {
  const ssh = await connectSsh(target);
  const sockets = new Set<Socket>();

  const server = createServer((local) => {
    sockets.add(local);
    // C6: ECONNRESET from the worker's socket during a reconnect is normal.
    local.on('error', (e: Error) => logger.warn('[plasma-ssh] local socket error:', e.message));
    local.on('close', () => sockets.delete(local));
    ssh.forwardOut('127.0.0.1', 0, target.pgHost, target.pgPort, (err, stream) => {
      noteForwardResult(target.id, err);
      if (err) {
        logger.error('[plasma-ssh] forwardOut failed:', err);
        local.destroy();
        return;
      }
      // pipeline() forwards errors and tears both ends down together.
      pipeline(local, stream, local, (pipeErr) => {
        if (pipeErr) logger.warn('[plasma-ssh] tunnel stream closed:', pipeErr.message);
        local.destroy();
        stream.destroy();
      });
    });
  });
  server.on('error', (e: Error) => logger.error('[plasma-ssh] local server error:', e.message));

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // Port 0 = OS picks a free one. Bind to 127.0.0.1 only — never
      // expose the tunnel to the network.
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (err) {
    try {
      ssh.end();
    } catch {
      // best-effort
    }
    throw err;
  }

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    server.close();
    ssh.end();
    throw new Error('ssh tunnel: failed to bind local port');
  }

  const tunnel: OpenTunnel = {
    server,
    ssh,
    localPort: addr.port,
    sockets,
    signature: signatureOf(target),
  };
  tunnels.set(target.id, tunnel);

  logger.info(
    '[plasma-ssh] tunnel open',
    target.id,
    `127.0.0.1:${addr.port} -> ${target.ssh.host}:${target.ssh.port} -> ${target.pgHost}:${target.pgPort}`,
  );

  // C13: identity-checked — a late close from a replaced client must not
  // evict the tunnel that superseded it.
  ssh.on('close', () => {
    if (tunnels.get(target.id) === tunnel) destroyTunnel(target.id, tunnel, 'ssh client closed');
  });

  return { host: '127.0.0.1', port: addr.port };
}

/**
 * Open (or reuse) the tunnel for `target.id`. A live tunnel to the same
 * target is reused; one to a different target is replaced. Concurrent
 * calls for the same id share one attempt.
 */
export function openTunnel(target: TunnelTarget): Promise<{ host: string; port: number }> {
  const pending = opening.get(target.id);
  if (pending) {
    // A close arrived while that attempt was in flight: it will be torn
    // down on arrival, so queue a fresh one behind it. Likewise when the
    // in-flight attempt is for another target (SC-29): handing back its
    // local port would route this caller to the wrong host.
    if (cancelled.has(target.id) || pending.signature !== signatureOf(target)) {
      return pending.promise.then(
        () => openTunnel(target),
        () => openTunnel(target),
      );
    }
    return pending.promise;
  }

  const cached = tunnels.get(target.id);
  if (cached) {
    if (cached.signature === signatureOf(target)) {
      return Promise.resolve({ host: '127.0.0.1', port: cached.localPort });
    }
    destroyTunnel(target.id, cached, 'target changed');
  }

  const attempt = createTunnel(target)
    .then((local) => {
      if (cancelled.has(target.id)) {
        const t = tunnels.get(target.id);
        if (t) destroyTunnel(target.id, t, 'closed while opening');
        throw new Error('ssh tunnel was closed while it was opening');
      }
      return local;
    })
    .finally(() => {
      opening.delete(target.id);
      cancelled.delete(target.id);
    });
  opening.set(target.id, { promise: attempt, signature: signatureOf(target) });
  return attempt;
}

/**
 * Remember how the last forward went: a failure is kept for the connection error to read, a
 * success clears it, so an old refusal on a tunnel that works again is never blamed for a later,
 * unrelated failure (a wrong password).
 */
export function noteForwardResult(id: string, err?: Error | null): void {
  if (err) forwardErrors.set(id, err.message);
  else forwardErrors.delete(id);
}

/** Why the jump host could not open the database port for this tunnel, if it could not. */
export function tunnelForwardError(id: string): string | undefined {
  return forwardErrors.get(id);
}

/** Close the tunnel for `id` (no-op when none is open). */
export function closeTunnel(id: string): void {
  if (opening.has(id)) cancelled.add(id);
  const t = tunnels.get(id);
  if (!t) return;
  destroyTunnel(id, t, 'closed');
}

export function closeAllTunnels(): void {
  for (const id of opening.keys()) cancelled.add(id);
  for (const [id, t] of [...tunnels.entries()]) destroyTunnel(id, t, 'shutdown');
}

/** Test hook — how many tunnels are open. */
export function openTunnelCount(): number {
  return tunnels.size;
}
