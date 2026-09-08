import { isConnectionLostError } from '@shared/connection-loss';
import type { ConnectionConfig, ConnectionEngine, WorkerRequest } from '@shared/protocol';

/**
 * U27 — transparent session recovery after a transport loss.
 *
 * The worker can tell that its sockets are dead (see
 * `workers/drivers/postgres.ts`) but it cannot rebuild the session on
 * its own: for SSH connections the tunnel lives in main, and only main
 * holds the credentials the worker was connected with. So main retains
 * the session it opened and, the first time a request comes back tagged
 * `connection-lost`, re-establishes tunnel + worker session and retries
 * the request once.
 *
 * Rules that matter:
 *   - one reconnect per burst: a screenful of panels all failing at once
 *     must not open five sessions (single-flight `recover()`)
 *   - retry reads, never replay writes (see `recoveryPolicy`)
 *   - a failed reconnect surfaces the original error and reports the
 *     session as gone, so the UI stops claiming to be connected
 */

/** Everything main needs to rebuild the worker's session (U27). */
export interface RetainedSession {
  /** Vault/connection id — also the SSH tunnel key. */
  id: string;
  /**
   * Config as saved, i.e. with the *real* host/port. When `tunnelled`,
   * the dial target is recomputed from a freshly opened tunnel.
   */
  config: ConnectionConfig;
  tunnelled: boolean;
}

export interface RecoveredSession {
  serverVersion: string;
  engine: ConnectionEngine;
  connectionGen: number;
  /** Reconnect attempts spent, ≥ 1. */
  attempts: number;
}

export interface DialTarget {
  host: string;
  port: number;
}

export interface RecoveryDeps {
  /** The session main opened, or null when the user is disconnected. */
  session(): RetainedSession | null;
  /** Re-open the SSH tunnel and hand back the local dial target. */
  reopenTunnel(session: RetainedSession): Promise<DialTarget>;
  /** Issue a fresh worker `connect` for `session` against `dial`. */
  connect(session: RetainedSession, dial: DialTarget | null): Promise<RecoveredSession>;
  /** Session is live again under a new connection generation. */
  onRecovered(recovered: RecoveredSession): void;
  /** Session is gone and could not be rebuilt. */
  onLost(reason: string): void;
  log(message: string, err?: unknown): void;
}

/**
 * What may happen to a request that died with the transport.
 *
 * `retry` — read-only or idempotent: rerun it on the new session.
 * `reconnect-only` — has side effects (writes, cancels, file exports) or
 *   is generation-bound: rebuild the session so the next request works,
 *   but never replay this one.
 * `none` — session plumbing; recovering around it would recurse.
 */
export type RecoveryPolicy = 'retry' | 'reconnect-only' | 'none';

/**
 * Anything absent is a read (or an idempotent lookup) and defaults to
 * `retry` — that default is what makes "run the query again and it just
 * works" true for every engine panel without listing them all.
 */
const POLICY_BY_KIND: Partial<Record<WorkerRequest['kind'], RecoveryPolicy>> = {
  // Session plumbing: recovery wraps these, so they must not recurse.
  connect: 'none',
  testConnect: 'none',
  disconnect: 'none',
  ping: 'none',
  setStatementTimeout: 'none',
  // Write boundary (U01): an edit batch belongs to the generation it was
  // stamped with and must be re-staged by the user, never auto-replayed.
  commitEditBatch: 'reconnect-only',
  // Cancels a backend pid that no longer exists on the new session.
  cancel: 'reconnect-only',
  // Side effects: replaying rewrites files / repeats mutations.
  exportQuery: 'reconnect-only',
  exportRows: 'reconnect-only',
  redisWrite: 'reconnect-only',
  redisDeleteKey: 'reconnect-only',
  redisBulkDelete: 'reconnect-only',
  redisSetTtl: 'reconnect-only',
  redisSubscribe: 'reconnect-only',
  redisUnsubscribe: 'reconnect-only',
  osCreateIndex: 'reconnect-only',
  osDeleteIndex: 'reconnect-only',
};

export function recoveryPolicy(kind: WorkerRequest['kind']): RecoveryPolicy {
  return POLICY_BY_KIND[kind] ?? 'retry';
}

export class ConnectionRecovery {
  private inFlight: Promise<RecoveredSession | null> | null = null;

  constructor(private readonly deps: RecoveryDeps) {}

  /**
   * Rebuild the retained session. Concurrent callers share one attempt so
   * a burst of failed panels yields a single reconnect.
   */
  recover(): Promise<RecoveredSession | null> {
    if (!this.inFlight) {
      this.inFlight = this.reconnect().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async reconnect(): Promise<RecoveredSession | null> {
    const session = this.deps.session();
    if (!session) {
      this.deps.log('[plasma] connection lost with no retained session — cannot recover');
      this.deps.onLost('connection lost and no session to restore');
      return null;
    }

    try {
      const dial = session.tunnelled ? await this.deps.reopenTunnel(session) : null;
      const recovered = await this.deps.connect(session, dial);
      this.deps.log(
        `[plasma] reconnected to ${session.config.host}:${session.config.port} (generation ${recovered.connectionGen})`,
      );
      this.deps.onRecovered(recovered);
      return recovered;
    } catch (err) {
      this.deps.log('[plasma] reconnect failed:', err);
      this.deps.onLost(err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  /**
   * Run a worker call, recovering once if it fails because the transport
   * died. Non-transport failures and second failures propagate untouched.
   */
  async run<T>(kind: WorkerRequest['kind'], call: () => Promise<T>): Promise<T> {
    const policy = recoveryPolicy(kind);
    if (policy === 'none') return call();

    try {
      return await call();
    } catch (err) {
      if (!isConnectionLostError(err)) throw err;
      this.deps.log(`[plasma] ${kind} hit a dead connection — reconnecting`, err);
      const recovered = await this.recover();
      if (!recovered || policy === 'reconnect-only') throw err;
      return call();
    }
  }
}
