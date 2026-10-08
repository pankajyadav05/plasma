import { isConnectionLostError } from '@shared/connection-loss';
import type { ConnectionConfig, ConnectionEngine, WorkerRequest } from '@shared/protocol';
import { isRedisReadCommand } from '@shared/redis-command-policy';

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
  // Isolated throwaway session: never worth rebuilding the live one for.
  compareQuery: 'none',
  compareSchema: 'none',
  compareCancel: 'none',
  disconnect: 'none',
  ping: 'none',
  setStatementTimeout: 'none',
  // Write boundary (U01): an edit batch belongs to the generation it was
  // stamped with and must be re-staged by the user, never auto-replayed.
  commitEditBatch: 'reconnect-only',
  // Structure DDL and imports: never replayed onto a fresh session.
  applyDdl: 'reconnect-only',
  importRun: 'reconnect-only',
  importCancel: 'none',
  exportCancel: 'none',
  cancelAux: 'reconnect-only',
  // C5: transaction control. A COMMIT replayed on a fresh session reports
  // success for work that was rolled back; BEGIN would silently open a
  // transaction the user thinks failed.
  beginTxn: 'reconnect-only',
  commitTxn: 'reconnect-only',
  rollbackTxn: 'reconnect-only',
  // Safe Run holds a transaction open on one session; a fresh session has
  // nothing to commit and must not re-execute the write.
  safeRunStart: 'reconnect-only',
  safeRunFinish: 'reconnect-only',
  safeRunUndoLast: 'reconnect-only',
  // Cancels a backend pid that no longer exists on the new session.
  cancel: 'reconnect-only',
  // Side effects: replaying rewrites files / repeats mutations.
  exportQuery: 'reconnect-only',
  exportRows: 'reconnect-only',
  sqliteBackup: 'reconnect-only',
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
 * Words that take a parenthesis without being function calls: clause
 * keywords, constructors and special forms.
 */
const SYNTAX_BEFORE_PAREN = new Set(
  (
    'select from where and or not in any all some exists as on using join left right inner outer ' +
    'cross full natural lateral union intersect except values with recursive over filter within ' +
    'group by order having limit offset fetch when then else case end between like ilike similar ' +
    'is distinct array row cast extract coalesce nullif greatest least rollup cube grouping sets ' +
    'window partition rows range table only collate escape explain verbose costs buffers format ' +
    'summary timing settings wal show current_timestamp current_time localtime localtimestamp ' +
    'numeric decimal varchar char character timestamp timestamptz time timetz interval bit varbit float'
  ).split(' '),
);

/**
 * Functions with no side effects (immutable / stable catalog or pure
 * computation). Anything else — user functions, nextval, pg_notify,
 * set_config, advisory locks, lo_* — blocks a replay (SC-04).
 */
const SAFE_FUNCTIONS = new Set(
  (
    'count sum avg min max bool_and bool_or every array_agg string_agg json_agg jsonb_agg ' +
    'json_object_agg jsonb_object_agg stddev variance corr percentile_cont percentile_disc mode ' +
    'lower upper length char_length character_length octet_length bit_length substr substring trim ' +
    'ltrim rtrim btrim replace concat concat_ws position strpos split_part initcap reverse lpad rpad ' +
    'repeat translate regexp_replace regexp_match regexp_matches regexp_split_to_array ' +
    'regexp_split_to_table ascii chr md5 encode decode format quote_ident quote_literal quote_nullable ' +
    'round ceil ceiling floor trunc abs sign mod power sqrt exp ln log div width_bucket ' +
    'to_char to_date to_timestamp to_number date_trunc date_part make_date make_time make_timestamp ' +
    'make_interval age now timezone isfinite justify_days justify_hours justify_interval ' +
    'jsonb_typeof json_typeof jsonb_array_length json_array_length jsonb_extract_path ' +
    'jsonb_extract_path_text json_extract_path json_extract_path_text jsonb_object_keys json_object_keys ' +
    'jsonb_each jsonb_each_text json_each json_each_text jsonb_array_elements json_array_elements ' +
    'jsonb_array_elements_text json_array_elements_text jsonb_build_object json_build_object ' +
    'jsonb_build_array json_build_array jsonb_set jsonb_strip_nulls jsonb_pretty to_json to_jsonb ' +
    'row_to_json array_to_json to_tsvector to_tsquery plainto_tsquery ts_rank ' +
    'generate_series unnest array_length array_upper array_lower cardinality array_position ' +
    'array_to_string string_to_array array_cat array_append array_prepend array_remove ' +
    'row_number rank dense_rank percent_rank cume_dist lag lead first_value last_value nth_value ntile ' +
    'current_setting current_database current_schema current_schemas current_user session_user version ' +
    'pg_typeof pg_size_pretty pg_total_relation_size pg_relation_size pg_table_size pg_indexes_size ' +
    'pg_database_size to_regclass to_regtype obj_description col_description pg_get_viewdef ' +
    'pg_get_indexdef pg_get_constraintdef pg_get_expr pg_get_userbyid format_type ' +
    'has_table_privilege has_schema_privilege has_database_privilege has_column_privilege ' +
    'inet_server_addr inet_client_addr host network masklen text int4 int8 numeric float8 ' +
    'bool uuid date oid regclass name'
  ).split(' '),
);

/** Blank out comments and quoted text so only structure remains. null = malformed. */
function stripSqlLiterals(sql: string): string | null {
  let out = '';
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i] as string;
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++;
      out += ' ';
    } else if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth > 0) return null;
      out += ' ';
    } else if (c === "'") {
      const escapes = /[eE]$/.test(out) && !/[\w$]/.test(out.slice(-2, -1) || ' ');
      i++;
      for (;;) {
        if (i >= n) return null;
        if (escapes && sql[i] === '\\') i += 2;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") {
          i++;
          break;
        } else i++;
      }
      out += "''";
    } else if (c === '"') {
      i++;
      for (;;) {
        if (i >= n) return null;
        if (sql[i] === '"' && sql[i + 1] === '"') i += 2;
        else if (sql[i] === '"') {
          i++;
          break;
        } else i++;
      }
      out += '"q"';
    } else if (c === '$') {
      const m = /^\$([A-Za-z_][\w]*)?\$/.exec(sql.slice(i));
      if (m && !/[\w$]$/.test(out)) {
        const end = sql.indexOf(m[0], i + m[0].length);
        if (end < 0) return null;
        i = end + m[0].length;
        out += "''";
      } else {
        out += c;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * C5 / F1 / SC-04: SQL that is *proven* safe to re-run on a fresh session:
 * a single SHOW, EXPLAIN without ANALYZE, or plain SELECT / VALUES / TABLE
 * / WITH whose only function calls are on an allow-list of side-effect-free
 * functions. A deny-list can't prove that (`SELECT charge_customer(42)`),
 * so anything unknown — user functions, nextval, pg_notify — is not
 * replayed and the user is told instead.
 */
export function isReplaySafeSql(sql: string): boolean {
  const stripped0 = stripSqlLiterals(sql);
  if (stripped0 === null) return false;
  const stripped = stripped0.trim().replace(/;\s*$/, '');
  if (!stripped || stripped.includes(';')) return false;
  const lower = stripped.toLowerCase();
  if (!/^(select|show|table|values|with|explain)\b/.test(lower)) return false;
  if (/^explain\b/.test(lower) && /\banalyze\b|\banalyse\b/.test(lower)) return false;
  if (
    /\b(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|copy|call|do|lock|into|for\s+(update|share|no\s+key\s+update|key\s+share)|set)\b/.test(
      lower,
    )
  ) {
    return false;
  }
  // Every `name(` / `schema.name(` must be syntax or an allow-listed function.
  const call = /((?:[a-z_][\w$]*|"q")\s*\.\s*)?([a-z_][\w$]*|"q")\s*\(/g;
  for (let m = call.exec(lower); m; m = call.exec(lower)) {
    const qualifier = m[1]?.replace(/[\s.]/g, '');
    const name = m[2] as string;
    if (name === '"q"') return false;
    if (qualifier) {
      if (qualifier !== 'pg_catalog' || !SAFE_FUNCTIONS.has(name)) return false;
      continue;
    }
    if (SYNTAX_BEFORE_PAREN.has(name) || SAFE_FUNCTIONS.has(name)) continue;
    // `... AS alias(col, col)` is a column alias list, not a call.
    if (/\bas\s+$/.test(lower.slice(0, m.index))) continue;
    return false;
  }
  return true;
}

export function recoveryPolicy(kind: WorkerRequest['kind'], req?: PolicyRequest): RecoveryPolicy {
  switch (kind) {
    case 'sidebandQuery':
      // Plasma's own lookups with a timeout run inside BEGIN READ ONLY on
      // the server, so a hidden write errors instead of repeating.
      if (typeof req?.timeoutMs === 'number' && req.timeoutMs > 0) return 'retry';
      return typeof req?.sql === 'string' && isReplaySafeSql(req.sql) ? 'retry' : 'reconnect-only';
    case 'query':
      // C5: user SQL is replayed only when it is provably a plain read.
      return typeof req?.sql === 'string' && isReplaySafeSql(req.sql) ? 'retry' : 'reconnect-only';
    case 'explain':
      // EXPLAIN ANALYZE executes the statement (nextval, triggers...).
      return req?.analyze === true ? 'reconnect-only' : 'retry';
    case 'redisCommand': {
      const parts = Array.isArray(req?.parts) ? req.parts.map((p) => String(p)) : [];
      return parts.length > 0 && isRedisReadCommand(parts) ? 'retry' : 'reconnect-only';
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
