import { isConnectionLostError } from '@shared/connection-loss';
import type { ConnectionConfig, ConnectionEngine, WorkerRequest } from '@shared/protocol';
import { isReadOnlyRedisCommand } from './ai-policy';

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
  /** Saved connection id the recovered session belongs to (C11). */
  connectionId?: string;
}

export interface DialTarget {
  host: string;
  port: number;
}

export interface RecoveryDeps {
  /** The session main opened, or null when the user is disconnected. */
  session(): RetainedSession | null;
  /**
   * C11: bumped by main whenever the user starts a connect or disconnect.
   * A recovery that sees it move gives up — the user has moved on, and
   * reconnecting the old session would put the worker on the wrong
   * database behind the UI's back.
   */
  epoch(): number;
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
  // C5: transaction control. A COMMIT replayed on a fresh session reports
  // success for work that was rolled back; BEGIN would silently open a
  // transaction the user thinks failed.
  beginTxn: 'reconnect-only',
  commitTxn: 'reconnect-only',
  rollbackTxn: 'reconnect-only',
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
  redisDeleteByPattern: 'reconnect-only',
  redisCancel: 'reconnect-only',
  osCreateIndex: 'reconnect-only',
  osDeleteIndex: 'reconnect-only',
  // O14/R4: raw REST calls and SQL may write; a cancel targets a dead request.
  osRequest: 'reconnect-only',
  osSql: 'reconnect-only',
  osCancel: 'reconnect-only',
};

/** Loose request shape — enough to judge whether a replay is safe. */
type PolicyRequest = { kind: WorkerRequest['kind'] } & Record<string, unknown>;

/**
 * C5 / F1: SQL that can be re-run on a fresh session without changing
 * anything — a single plain read. Anything that might write, lock, call a
 * side-effecting function or depend on session state is not replayed.
 */
export function isReplaySafeSql(sql: string): boolean {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .trim()
    .replace(/;\s*$/, '');
  if (!stripped || stripped.includes(';')) return false;
  const lower = stripped.toLowerCase();
  if (!/^(select|show|table|values|with|explain)\b/.test(lower)) return false;
  if (/^explain\b[^;]*\banalyze\b/.test(lower)) return false;
  if (
    /\b(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|copy|call|do|lock|into|for\s+(update|share|no\s+key\s+update|key\s+share)|nextval|setval|pg_terminate_backend|pg_cancel_backend|pg_advisory\w*|pg_reload_conf|pg_rotate_logfile|set_config|lo_\w+|dblink\w*|pg_sleep\w*)\b/.test(
      lower,
    )
  ) {
    return false;
  }
  return true;
}

export function recoveryPolicy(kind: WorkerRequest['kind'], req?: PolicyRequest): RecoveryPolicy {
  switch (kind) {
    case 'query':
    case 'sidebandQuery':
      // C5: user SQL is replayed only when it is provably a plain read.
      return typeof req?.sql === 'string' && isReplaySafeSql(req.sql) ? 'retry' : 'reconnect-only';
    case 'redisCommand': {
      const parts = Array.isArray(req?.parts) ? req.parts.map((p) => String(p)) : [];
      return parts.length > 0 && isReadOnlyRedisCommand(parts) ? 'retry' : 'reconnect-only';
    }
  }
  return POLICY_BY_KIND[kind] ?? 'retry';
}

/**
 * Error surfaced when a request died with the transport and was not
 * re-run. The session is back, but the user decides what to do next.
 */
export class NotReplayedError extends Error {
  override readonly name = 'NotReplayedError';
  constructor(original: unknown, opts: { txnLost: boolean; recovered: boolean }) {
    const detail = original instanceof Error ? original.message : String(original);
    const head = opts.txnLost
      ? 'Connection lost during an open transaction — the transaction was rolled back by the server and nothing was re-run.'
      : 'Connection lost — the statement was not re-run; it may or may not have been applied.';
    const tail = opts.recovered ? ' Reconnected: check the data before trying again.' : '';
    super(`${head}${tail} (${detail})`);
  }
}

function isTxnLost(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { txnLost?: unknown }).txnLost === true);
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
    const epoch = this.deps.epoch();
    // C11: the user switched or disconnected while we were working.
    const superseded = () => this.deps.epoch() !== epoch || this.deps.session() !== session;

    try {
      const dial = session.tunnelled ? await this.deps.reopenTunnel(session) : null;
      if (superseded()) {
        this.deps.log('[plasma] recovery abandoned — the user changed connection');
        return null;
      }
      const recovered = await this.deps.connect(session, dial);
      if (superseded()) {
        this.deps.log('[plasma] recovery abandoned — the user changed connection');
        return null;
      }
      this.deps.log(
        `[plasma] reconnected to ${session.config.host}:${session.config.port} (generation ${recovered.connectionGen})`,
      );
      const withId = { ...recovered, connectionId: session.id };
      this.deps.onRecovered(withId);
      return withId;
    } catch (err) {
      this.deps.log('[plasma] reconnect failed:', err);
      if (superseded()) return null;
      this.deps.onLost(err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  /**
   * Run a worker call, recovering once if it fails because the transport
   * died. Non-transport failures and second failures propagate untouched.
   */
  async run<T>(
    kind: WorkerRequest['kind'],
    call: () => Promise<T>,
    req?: PolicyRequest,
  ): Promise<T> {
    const policy = recoveryPolicy(kind, req);
    if (policy === 'none') return call();

    try {
      return await call();
    } catch (err) {
      if (!isConnectionLostError(err)) throw err;
      this.deps.log(`[plasma] ${kind} hit a dead connection — reconnecting`, err);
      const recovered = await this.recover();
      const txnLost = isTxnLost(err);
      if (txnLost || (policy === 'reconnect-only' && recovered)) {
        throw new NotReplayedError(err, { txnLost, recovered: Boolean(recovered) });
      }
      if (!recovered) throw err;
      return call();
    }
  }
}
