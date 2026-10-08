import { ConnectionLostError } from '@shared/connection-loss';
import { pgReadOnlyEscapeReason } from '@shared/pg-readonly-sql';
import { pgTypeName } from '@shared/pg-type-oids';
import type {
  ConnectionConfig,
  IntrospectOpts,
  PgNotice,
  QueryResult,
  SchemaInfo,
  TxnState,
} from '@shared/protocol';
import type { SafeRunOutcome, SafeRunReport, SafeRunUndoResult } from '@shared/protocol';
import type {
  DdlApplyRequest,
  DdlApplyResult,
  ImportJobSpec,
  ImportResult,
} from '@shared/protocol';
import {
  FIRST_CURSOR_CHUNK,
  MAX_RESULT_BYTES,
  MAX_RESULT_BYTES_CEILING,
  MAX_RESULT_ROWS,
  appendBoundedRows,
  emptyBoundState,
  nextCursorChunk,
} from '@shared/result-bounds';
import { planSafeRunScript } from '@shared/safe-run-script';
import { splitSqlStatementRanges } from '@shared/sql-split';
import { isSingleSqlStatement, isTxnExemptSql } from '@shared/sql-statements';
import {
  type PlasmaTlsOptions,
  buildNodeTlsOptions,
  insecureTlsWarning,
  isUnverifiedTlsMode,
  resolveTls,
} from '@shared/tls';
import { formatStatementTimeoutSql } from '@shared/worker-policy';
import pg from 'pg';
import Cursor from 'pg-cursor';
import { runBootstrapSql } from './pg-bootstrap';
import { type ImportHooks, applyDdl, runImport } from './pg-import';
import { PgListener } from './pg-listener';
import { enforceReadOnlySession } from './pg-readonly';
import {
  type CappedRead,
  type SafeRunBody,
  type SafeRunScriptState,
  doneSteps,
  finishSafeRun,
  rollbackSafeRun,
  scriptReportBody,
  startSafeRun,
  startSafeRunScript,
  undoLastScriptStatement,
} from './pg-safe-run';
import {
  type EditBatchConflict,
  type EditBatchOutcome,
  type EditUpdate,
  type TxnStatus,
  runEditBatch,
  runExplain,
  txnStateFromStatus,
} from './pg-txn';
import { plasmaPgTypes } from './pg-type-parsers';
import { introspectPostgres } from './postgres-introspect';
import { type AiQueryOpts, CancelFailedError } from './sql-engine';

/** Rows counted past the display cap before Safe Run stops counting. */
const SAFE_RUN_COUNT_CEILING = 1_000_000;
const SAFE_RUN_BLOCKED_MESSAGE =
  'A Safe Run is waiting for your decision. Commit or roll it back before running anything else on this connection.';

interface PendingSafeRun {
  runId: string;
  nested: boolean;
  expiresAt: number;
  timeoutSec: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** A finish (commit / rollback / timeout) is already in progress. */
  ending: boolean;
  /** An undo is in progress (the review timer is stopped meanwhile). */
  undoing: boolean;
  /** Set for a script of several statements. */
  script: SafeRunScriptState | null;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const { Client } = pg;
type ClientT = InstanceType<typeof Client>;
interface PgNoticeRaw {
  message?: string;
  severity?: string;
  name?: string;
  code?: string;
  detail?: string;
  hint?: string;
  where?: string;
}
function toPgNotice(n: PgNoticeRaw): PgNotice {
  return {
    message: n.message ?? '',
    severity: n.severity || n.name || undefined,
    code: n.code || undefined,
    detail: n.detail || undefined,
    hint: n.hint || undefined,
    where: n.where || undefined,
  };
}

/**
 * U27 — a socket killed by a VPN drop / sleep / Wi-Fi switch is usually
 * half-open: writes are accepted by the local kernel and never answered,
 * and `query` / `sidebandQuery` carry no IPC deadline (their budget is
 * server-side `statement_timeout`, which a dead socket never reaches).
 * So before reusing a connection that has been idle long enough for the
 * network to have changed underneath it, probe it under a hard cap.
 */
const IDLE_PROBE_AFTER_MS = 15_000;
const LIVENESS_PROBE_TIMEOUT_MS = 5_000;
/** TCP keepalive so the kernel tears down silently-dead sockets for us. */
const KEEPALIVE_INITIAL_DELAY_MS = 10_000;

/** Override the liveness windows above (tests, and only tests, need this). */
export interface PostgresLivenessOptions {
  idleProbeAfterMs?: number;
  probeTimeoutMs?: number;
  /** Bound on closing a cursor whose connection may be dead (P1-1). */
  closeTimeoutMs?: number;
  /** Bound on the control connection's pg_cancel_backend round trip (P2-1). */
  cancelTimeoutMs?: number;
}

const CURSOR_CLOSE_TIMEOUT_MS = 2_000;
const CANCEL_TIMEOUT_MS = 3_000;

/** A server ErrorResponse (SQLSTATE) proves the transport is alive. */
function isServerError(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    typeof err.code === 'string' &&
    /^[0-9A-Z]{5}$/.test(err.code)
  );
}

export type QueryChunkHandler = (chunk: {
  rows: unknown[][];
  columns?: QueryResult['columns'];
  chunkIndex: number;
  done: boolean;
  truncated: boolean;
}) => void;

type QueryOpts = {
  revision?: number;
  onChunk?: QueryChunkHandler;
  /** Editor row limit; defaults to the MAX_RESULT_ROWS safety cap. */
  maxRows?: number;
  /** Transaction mode (F9): BEGIN first when the session is idle. */
  autoBegin?: boolean;
  /** Sideband only: run read-only under this statement_timeout (F12). */
  timeoutMs?: number;
  /** Retained-bytes cap for this result (clamped to MAX_RESULT_BYTES_CEILING). */
  maxBytes?: number;
  /** Raise the MAX_RESULT_ROWS ceiling for this read (Result Compare). */
  rowCeiling?: number;
};

/** True while the client has a statement running or queued (best effort). */
function hasInflightQuery(client: ClientT | null): boolean {
  if (!client) return false;
  const c = client as unknown as { _activeQuery?: unknown; queryQueue?: unknown[] };
  if (c._activeQuery === undefined) return true; // unknown pg internals: assume busy
  return c._activeQuery !== null || (c.queryQueue?.length ?? 0) > 0;
}

/** F11: at most this many notices are kept / streamed per statement. */
export const MAX_NOTICES_PER_STATEMENT = 1000;

function readCursorBatch(
  cursor: Cursor<unknown[]>,
  n: number,
): Promise<{ rows: unknown[][]; fields: pg.FieldDef[]; command?: string; rowCount: number }> {
  return new Promise((resolve, reject) => {
    cursor.read(n, (err, rows, result) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({
        rows: (rows ?? []) as unknown[][],
        fields: result?.fields ?? [],
        command: result?.command,
        rowCount: result?.rowCount ?? rows?.length ?? 0,
      });
    });
  });
}

/**
 * Postgres driver — wraps three `pg.Client` connections (U19):
 *   1. `primary` — carries user queries / transactions
 *   2. `control` — cancel only (`pg_cancel_backend`); never runs AI/monitor SQL
 *   3. `aux` — AI tools + live monitor / terminate so they cannot block cancel
 *
 * Lives in the utilityProcess so a crashing query or a rogue network read
 * never blocks the main process or the renderer.
 */
/**
 * Names for custom type OIDs, and whether a grid commit can compare them:
 * a composite, or a type (after resolving a domain to its base and an array to
 * its element) with no `=` operator, cannot be put in a guarded WHERE.
 */
const CUSTOM_TYPE_SQL = `
  SELECT t.oid::int AS oid, format_type(t.oid, NULL) AS name,
    (e.typtype = 'c' OR (e.typtype NOT IN ('e', 'r', 'm') AND NOT EXISTS (
       SELECT 1 FROM pg_operator o WHERE o.oprname = '=' AND o.oprleft = e.oid AND o.oprright = e.oid
    ))) AS noeq
  FROM pg_type t
  JOIN pg_type b ON b.oid = CASE WHEN t.typtype = 'd' THEN t.typbasetype ELSE t.oid END
  JOIN pg_type e ON e.oid = CASE WHEN b.typelem <> 0 AND b.typlen = -1 THEN b.typelem ELSE b.oid END
  WHERE t.oid = ANY($1::oid[])`;

export class PostgresDriver {
  private primary: ClientT | null = null;
  private control: ClientT | null = null;
  private aux: ClientT | null = null;
  private primaryBackendPid: number | null = null;
  private auxBackendPid: number | null = null;
  private txnState: TxnState = 'none';
  private statementTimeoutMs = 0;
  private connectionGen = 0;
  /** SC-02: re-assert / verify read-only before every user statement. */
  private readOnlySession = false;
  /** Notices accumulated for the in-flight primary query (U26). */
  private pendingNotices: PgNotice[] = [];
  /** Optional fan-out so the worker can stream notices over the event channel. */
  private noticeListener: ((notice: PgNotice) => void) | null = null;
  /** Why the transport died, once known — reported to every later caller (U27). */
  private lostReason: string | null = null;
  /** The transport died while a user transaction was open (C5). */
  private lostInTxn = false;
  /** Safe Run held open on the primary; everything else on it is refused meanwhile. */
  private safeRun: PendingSafeRun | null = null;
  /** The last Safe Run that ended without the renderer asking (timeout, disconnect). */
  private lastSafeRunEnd: SafeRunOutcome | null = null;
  /** Timestamp of the last statement the server actually answered (U27). */
  private lastActivityAt = 0;
  private readonly idleProbeAfterMs: number;
  private readonly probeTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly cancelTimeoutMs: number;
  /** Wakes cursor closes that are waiting on a connection that just died. */
  private lostWaiters = new Set<() => void>();
  /** statement_timeout last applied to each session (P2-5). */
  private appliedTimeout: { primary: number | null; aux: number | null } = {
    primary: null,
    aux: null,
  };

  constructor(liveness?: PostgresLivenessOptions) {
    this.idleProbeAfterMs = liveness?.idleProbeAfterMs ?? IDLE_PROBE_AFTER_MS;
    this.probeTimeoutMs = liveness?.probeTimeoutMs ?? LIVENESS_PROBE_TIMEOUT_MS;
    this.closeTimeoutMs = liveness?.closeTimeoutMs ?? CURSOR_CLOSE_TIMEOUT_MS;
    this.cancelTimeoutMs = liveness?.cancelTimeoutMs ?? CANCEL_TIMEOUT_MS;
  }

  /** Config of the live session, kept so the LISTEN/NOTIFY tail can dial its own connection. */
  private listenConfig: ConnectionConfig | null = null;
  /** LISTEN/NOTIFY tail on a dedicated connection — never the primary. */
  private readonly listener = new PgListener(async () => {
    const config = this.listenConfig;
    if (!config) throw new Error('not connected');
    let ssl: PlasmaTlsOptions | false = buildNodeTlsOptions(config) ?? false;
    const mode = resolveTls(config)?.mode;
    const dial = async () => {
      const client = new Client(this.clientOpts(config, 'plasma-listen', ssl));
      client.on('error', () => {});
      try {
        await client.connect();
      } catch (err) {
        await client.end().catch(() => undefined);
        throw err;
      }
      return client;
    };
    try {
      return await dial();
    } catch (err) {
      if (mode !== 'prefer' || !/does not support ssl/i.test(errorMessage(err))) throw err;
      ssl = false;
      return await dial();
    }
  });

  setNotificationListener(fn: Parameters<PgListener['setListener']>[0]): void {
    this.listener.setListener(fn);
  }

  listen(channel: string): Promise<void> {
    if (!this.primary) throw new Error('not connected');
    return this.listener.listen(channel);
  }

  unlisten(channel: string): Promise<void> {
    return this.listener.unlisten(channel);
  }

  /** `pg_notify` on the aux session, so an open transaction on the primary never holds it back. */
  async notify(channel: string, payload: string): Promise<void> {
    await this.withAux(async (client) => {
      await client.query('SELECT pg_notify($1, $2)', [channel, payload]);
    });
  }

  /** Subscribe to NOTICE / RAISE NOTICE events from the primary client. */
  setNoticeListener(listener: ((notice: PgNotice) => void) | null): void {
    this.noticeListener = listener;
  }

  /** Notices dropped past MAX_NOTICES_PER_STATEMENT for the in-flight statement (F11). */
  private droppedNotices = 0;
  /** Serialises aux work so multi-statement sideband/AI runs never interleave (F12/F19). */
  private auxChain: Promise<unknown> = Promise.resolve();

  private handleNotice = (raw: PgNoticeRaw): void => {
    // F11: a DO loop raising 100k notices must not flood memory or IPC.
    if (this.pendingNotices.length >= MAX_NOTICES_PER_STATEMENT) {
      this.droppedNotices++;
      return;
    }
    const notice = toPgNotice(raw);
    this.pendingNotices.push(notice);
    this.noticeListener?.(notice);
  };

  /**
   * F4/C31: the server's ReadyForQuery status (I/T/E) is the only source
   * of truth for the primary's transaction state — no SQL prefix guessing.
   */
  private handleReadyForQuery = (msg: { status?: string }): void => {
    const status = (msg.status === 'T' || msg.status === 'E' ? msg.status : 'I') as TxnStatus;
    this.txnState = txnStateFromStatus(status);
  };

  private txnStatus(): TxnStatus {
    return this.txnState === 'active' ? 'T' : this.txnState === 'error' ? 'E' : 'I';
  }

  /**
   * Names for type OIDs with no fixed number (enums, domains, composites,
   * extension types). Per connection: the same OID means another type in
   * another database, so the map is dropped on teardown.
   */
  private customTypeNames = new Map<number, string>();
  /** OIDs of custom types that cannot be compared with `=` (see ColumnMeta.noEquality). */
  private customNoEquality = new Set<number>();

  /**
   * Replace `oid:NNNN` column type names with the server's own name
   * (`order_status`, `public.money_amount`…). Looked up on the aux
   * connection so it never runs inside the user's transaction; any failure
   * leaves the placeholder, which the renderer still shows.
   */
  private async resolveColumnTypeNames(
    columns: QueryResult['columns'],
    /** Set when already running inside an aux job (withAux would deadlock on itself). */
    auxClient?: ClientT,
  ): Promise<void> {
    const unknown = [
      ...new Set(
        columns
          .filter(
            (c) => c.dataTypeName?.startsWith('oid:') && !this.customTypeNames.has(c.dataTypeID),
          )
          .map((c) => c.dataTypeID),
      ),
    ];
    if (unknown.length > 0) {
      try {
        const lookup = (client: ClientT) =>
          client.query<{ oid: number; name: string; noeq: boolean }>(CUSTOM_TYPE_SQL, [unknown]);
        const res = auxClient ? await lookup(auxClient) : await this.withAux(lookup);
        for (const r of res.rows) {
          this.customTypeNames.set(Number(r.oid), r.name);
          if (r.noeq) this.customNoEquality.add(Number(r.oid));
        }
      } catch {
        return;
      }
    }
    for (const c of columns) {
      const name = this.customTypeNames.get(c.dataTypeID);
      if (name && c.dataTypeName?.startsWith('oid:')) c.dataTypeName = name;
      if (this.customNoEquality.has(c.dataTypeID)) c.noEquality = true;
    }
  }

  private withAux<T>(fn: (client: ClientT) => Promise<T>): Promise<T> {
    const run = this.auxChain.then(async () => fn(await this.requireClient('aux')));
    this.auxChain = run.catch(() => {});
    return run;
  }

  isConnected(): boolean {
    return this.primary !== null;
  }

  getTxnState(): TxnState {
    return this.txnState;
  }

  private clientOpts(
    config: ConnectionConfig,
    application_name: string,
    ssl: PlasmaTlsOptions | false = buildNodeTlsOptions(config) ?? false,
  ) {
    return {
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      // C4: honour the connection's TLS mode (verify-full by default)
      // instead of always skipping certificate checks.
      ssl,
      connectionTimeoutMillis: 10_000,
      // U27: without keepalive a VPN drop leaves an idle socket that
      // looks writable forever. The kernel probes and fails it instead.
      keepAlive: true,
      keepAliveInitialDelayMillis: KEEPALIVE_INITIAL_DELAY_MS,
      application_name,
      // F6: keep Postgres text for dates, timestamps, intervals, bytea,
      // numeric, arrays… — no JS Date conversion (see pg-type-parsers.ts).
      types: plasmaPgTypes,
    };
  }

  /**
   * Tear the session down because the transport is gone (U27).
   *
   * `pg.Client` re-emits socket errors on itself: with no listener the
   * idle drop becomes an `uncaughtException` that kills the worker, and
   * with a listener but no teardown the client stays non-null while
   * every later query fails with "not queryable". Both leave the app
   * claiming to be connected, which is the bug this closes.
   */
  private markConnectionLost(reason: string): void {
    const clients = [this.primary, this.control, this.aux];
    // Nothing live to lose — either already lost, or our own disconnect()
    // dropped the refs and this is the resulting 'end' event.
    if (clients.every((c) => c === null)) return;

    console.error('[plasma] postgres connection lost:', reason);
    this.lostReason = reason;
    this.lostInTxn = this.txnState === 'active';
    this.txnState = 'none';
    this.dropSafeRun('disconnect');
    this.primaryBackendPid = null;
    this.auxBackendPid = null;
    this.pendingNotices = [];
    this.primary = null;
    this.control = null;
    this.aux = null;
    this.customTypeNames.clear();
    this.customNoEquality.clear();
    this.appliedTimeout = { primary: null, aux: null };
    for (const wake of [...this.lostWaiters]) wake();

    for (const client of clients) {
      if (!client) continue;
      client.removeListener('notice', this.handleNotice);
      client.connection.removeListener('readyForQuery', this.handleReadyForQuery);
      // end() waits for a Terminate round trip the dead peer will never
      // complete, so release the fd directly and swallow the fallout.
      client.connection.stream.destroy();
      client.end().catch(() => {});
    }
  }

  private attachLifecycle(client: ClientT, role: string): void {
    client.on('error', (err: Error) => this.markConnectionLost(`${role}: ${err.message}`));
    client.on('end', () => this.markConnectionLost(`${role}: connection closed by server`));
  }

  /**
   * Resolve the client for a statement, refusing fast when the transport
   * is known dead and probing it when it has been idle long enough for
   * the network to have changed underneath us (U27).
   */
  private async requireClient(role: 'primary' | 'aux' | 'control'): Promise<ClientT> {
    if (this.lostReason) throw new ConnectionLostError(this.lostReason);
    const client = role === 'primary' ? this.primary : role === 'aux' ? this.aux : this.control;
    if (!client) throw new Error('not connected');
    if (
      Date.now() - this.lastActivityAt >= this.idleProbeAfterMs &&
      // An aborted transaction answers everything with 25P02: the probe
      // would prove nothing, and the next statement finds out anyway.
      !(role === 'primary' && this.txnStatus() === 'E')
    ) {
      await this.probe(client, role);
      if (this.lostReason) throw new ConnectionLostError(this.lostReason);
    }
    if (role === 'primary' || role === 'aux') await this.syncStatementTimeout(role, client);
    return client;
  }

  /**
   * P2-5: statement_timeout changes are applied only while the session is
   * outside a transaction (a SET inside one is undone by ROLLBACK, and
   * fails in an aborted one); the next statement after it ends applies it.
   */
  private async syncStatementTimeout(role: 'primary' | 'aux', client: ClientT): Promise<void> {
    if (this.appliedTimeout[role] === this.statementTimeoutMs) return;
    if (role === 'primary' && this.txnStatus() !== 'I') return;
    await client.query(formatStatementTimeoutSql(this.statementTimeoutMs));
    // Re-check: a connection loss while awaiting resets the table.
    if (this.primary === client || this.aux === client) {
      this.appliedTimeout[role] = this.statementTimeoutMs;
    }
  }

  /** `SELECT 1` under a hard cap; a half-open socket simply never answers. */
  private async probe(client: ClientT, role: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answer = client.query('SELECT 1');
    // The race loser must not surface as an unhandled rejection.
    answer.catch(() => {});
    try {
      await Promise.race([
        answer,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`no answer in ${this.probeTimeoutMs}ms`)),
            this.probeTimeoutMs,
          );
        }),
      ]);
      this.lastActivityAt = Date.now();
    } catch (err) {
      // SC-03: an ErrorResponse (aborted transaction, permission...) means
      // the server answered, so the transport is alive.
      if (isServerError(err)) {
        this.lastActivityAt = Date.now();
        return;
      }
      const detail = err instanceof Error ? err.message : String(err);
      this.markConnectionLost(`${role} liveness probe failed: ${detail}`);
      throw new ConnectionLostError(`${role} liveness probe failed: ${detail}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** True when the session was lost with a transaction open (C5). */
  lostDuringTransaction(): boolean {
    return this.lostInTxn;
  }

  async connect(config: ConnectionConfig, statementTimeoutMs?: number): Promise<string> {
    // Hang up any previous clients first
    await this.disconnect();
    this.readOnlySession = config.readOnly === true;
    this.listenConfig = config;

    if (statementTimeoutMs !== undefined) {
      this.statementTimeoutMs = Math.max(0, Math.floor(statementTimeoutMs));
    }

    let ssl: PlasmaTlsOptions | false = buildNodeTlsOptions(config) ?? false;
    const mode = resolveTls(config)?.mode;
    if (isUnverifiedTlsMode(mode)) console.warn(insecureTlsWarning(config.host));

    // C23: build all three clients locally and publish them only once the
    // whole session is up, so a failed control/aux connect can't leave a
    // half-open driver that claims to be connected.
    const opened: ClientT[] = [];
    const open = async (name: string): Promise<ClientT> => {
      const client = new Client(this.clientOpts(config, name, ssl));
      opened.push(client);
      // Swallow socket errors until attachLifecycle takes over; an
      // unhandled 'error' would kill the worker.
      client.on('error', () => {});
      await client.connect();
      return client;
    };

    try {
      let primary: ClientT;
      try {
        primary = await open('plasma');
      } catch (err) {
        // libpq `prefer`: fall back to plaintext when the server has no TLS.
        if (mode !== 'prefer' || !/does not support ssl/i.test(errorMessage(err))) throw err;
        opened.length = 0;
        ssl = false;
        primary = await open('plasma');
      }
      // Grab the backend pid so control can cancel it
      const pidRes = await primary.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      // Control connection — cancel capacity only (U19)
      const control = await open('plasma-control');
      // Aux connection — AI / monitor execution budget, separate from cancel
      const aux = await open('plasma-aux');

      // C1: a read-only connection is enforced by the server, not just by
      // hidden buttons. Every transaction on primary + aux starts READ ONLY.
      if (config.readOnly) {
        for (const client of [primary, aux]) {
          await client.query('SET default_transaction_read_only = on');
        }
      }

      // P2-4: bytea values are shown / exported from their hex text form; a
      // server or role default of `escape` would garble them. Bootstrap SQL
      // below can still override this deliberately.
      for (const client of [primary, aux]) {
        await client.query("SET bytea_output = 'hex'");
      }

      // C28: per-connection bootstrap SQL (search_path, time zone, role…).
      await runBootstrapSql(primary, config.bootstrapSql);
      // SC-14: aux carries AI tool queries, lookups and introspection; it must
      // run under the same role / search_path as the user's session.
      await runBootstrapSql(aux, config.bootstrapSql);

      // U26: capture RAISE NOTICE / server notices for the messages strip
      // and stream them to the worker's broadcast channel.
      primary.on('notice', this.handleNotice);
      primary.connection.on('readyForQuery', this.handleReadyForQuery);
      this.attachLifecycle(primary, 'primary');
      this.attachLifecycle(control, 'control');
      this.attachLifecycle(aux, 'aux');
      this.primary = primary;
      this.control = control;
      this.aux = aux;
      this.primaryBackendPid = pidRes.rows[0]?.pid ?? null;
      this.auxBackendPid =
        (await aux.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid ?? null;

      await this.applyStatementTimeout();

      const res = await primary.query<{ version: string }>('SELECT version()');
      this.lastActivityAt = Date.now();
      return res.rows[0]?.version ?? 'unknown';
    } catch (err) {
      if (this.primary) {
        await this.disconnect();
      } else {
        await Promise.allSettled(opened.map((c) => c.end()));
      }
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.txnState = 'none';
    this.dropSafeRun('disconnect');
    this.lostInTxn = false;
    this.primaryBackendPid = null;
    this.pendingNotices = [];
    this.lostReason = null;
    this.lastActivityAt = 0;
    this.appliedTimeout = { primary: null, aux: null };
    const p = this.primary;
    const c = this.control;
    const a = this.aux;
    // Leave the 'error'/'end' listeners attached: end() can still fail
    // on a dead socket, and an unhandled 'error' kills the worker. They
    // no-op now that the refs below are cleared.
    if (p) {
      p.removeListener('notice', this.handleNotice);
      p.connection.removeListener('readyForQuery', this.handleReadyForQuery);
    }
    this.primary = null;
    this.control = null;
    this.aux = null;
    await Promise.allSettled([p?.end(), c?.end(), a?.end(), this.listener.close()]);
  }

  /**
   * Apply `queryTimeoutMs` as PostgreSQL `statement_timeout` on primary + aux.
   * Control is left alone so cancel is never delayed by a session timeout (U20).
   */
  async setStatementTimeout(timeoutMs: number): Promise<void> {
    this.statementTimeoutMs = Math.max(0, Math.floor(timeoutMs));
    // P2-5: primary picks the new value up before its next statement that
    // starts outside a transaction (see syncStatementTimeout); aux runs it
    // through its own chain so it can't land inside a sideband BEGIN...COMMIT.
    if (this.aux) await this.withAux(async () => {});
  }

  /** Connect time: both sessions are idle, so apply directly. */
  private async applyStatementTimeout(): Promise<void> {
    const sql = formatStatementTimeoutSql(this.statementTimeoutMs);
    if (this.primary) {
      await this.primary.query(sql);
      this.appliedTimeout.primary = this.statementTimeoutMs;
    }
    if (this.aux) {
      await this.aux.query(sql);
      this.appliedTimeout.aux = this.statementTimeoutMs;
    }
  }

  /**
   * SC-02: on read-only connections refuse statements that try to switch
   * the session back to read-write, and re-assert / verify the read-only
   * flag before the statement runs (see pg-readonly.ts).
   */
  private async guardReadOnly(client: ClientT, sql: string, status: TxnStatus): Promise<void> {
    if (!this.readOnlySession) return;
    const why = pgReadOnlyEscapeReason(sql);
    if (why) {
      throw new Error(
        `Read-only connection: ${why} is not allowed. Edit the connection to turn off read-only.`,
      );
    }
    await enforceReadOnlySession(client, status);
  }

  /**
   * Run SQL on the primary connection with pg-cursor bounded reads (U15).
   * Stops at MAX_RESULT_ROWS / MAX_RESULT_BYTES and sets `truncated`.
   * Optional `onChunk` emits cursor batches for the event channel (step 2).
   */
  async query(sql: string, params?: unknown[], opts?: QueryOpts): Promise<QueryResult> {
    this.assertNoSafeRun();
    const client = await this.requireClient('primary');
    await this.guardReadOnly(client, sql, this.txnStatus());

    // F9: Transaction mode — open a transaction before the first statement
    // of a unit of work, unless the statement manages transactions itself
    // or cannot run inside one (VACUUM, CREATE INDEX CONCURRENTLY, …).
    if (opts?.autoBegin && this.txnStatus() === 'I' && !isTxnExemptSql(sql)) {
      await client.query('BEGIN');
    }

    this.pendingNotices = [];
    this.droppedNotices = 0;
    const start = Date.now();
    let result: Awaited<ReturnType<PostgresDriver['runBounded']>>;
    try {
      result = await this.runBounded(client, sql, params, opts);
    } catch (err) {
      // P2-6: a statement that RAISEd and then failed keeps its notices.
      const notices = this.takeNotices();
      if (err instanceof Error && notices.length > 0) {
        (err as Error & { notices?: PgNotice[] }).notices = notices;
      }
      throw err;
    }
    const durationMs = Date.now() - start;
    const notices = this.takeNotices();

    // F4/C31: txnState is kept current by handleReadyForQuery.
    return {
      ...result,
      durationMs,
      notices: notices.length > 0 ? notices : undefined,
      txnState: this.txnState,
    };
  }

  /** Drain the in-flight statement's notices, noting any that were capped (F11). */
  private takeNotices(): PgNotice[] {
    const notices = this.pendingNotices;
    if (this.droppedNotices > 0) {
      notices.push({
        message: `${this.droppedNotices.toLocaleString('en-US')} more notices were not shown (limit ${MAX_NOTICES_PER_STATEMENT} per statement).`,
        severity: 'NOTICE',
      });
    }
    this.pendingNotices = [];
    this.droppedNotices = 0;
    return notices;
  }

  /**
   * Run a query on the aux connection (AI tools, live monitor,
   * pg_terminate_backend). Never touches the control cancel client (U19).
   *
   * Aux never participates in the primary's transaction state.
   */
  async sidebandQuery(sql: string, params?: unknown[], opts?: QueryOpts): Promise<QueryResult> {
    return this.withAux(async (client) => {
      const start = Date.now();
      await this.guardReadOnly(client, sql, 'I');
      if (!opts?.timeoutMs) {
        const result = await this.runBounded(client, sql, params, opts);
        return { ...result, durationMs: Date.now() - start };
      }
      // F12: Plasma's own lookups (counts, autocomplete, role lists) run
      // read-only and under a short timeout so they can never write or
      // hog the aux session.
      const timeout = Math.max(1, Math.floor(opts.timeoutMs));
      try {
        await client.query('BEGIN READ ONLY');
        await client.query(`SET LOCAL statement_timeout = ${timeout}`);
        const result = await this.runBounded(client, sql, params, opts);
        await client.query('COMMIT');
        return { ...result, durationMs: Date.now() - start };
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {}
        throw err;
      }
    });
  }

  /**
   * EXPLAIN one statement on the primary (F2). ANALYZE executes it inside
   * a transaction (or savepoint) that is always rolled back.
   */
  async explain(sql: string, analyze: boolean, params?: unknown[]): Promise<QueryResult> {
    this.assertNoSafeRun();
    const client = await this.requireClient('primary');
    await this.guardReadOnly(client, sql, this.txnStatus());
    const start = Date.now();
    this.takeNotices();
    try {
      const result = await runExplain(client, this.txnStatus(), sql, analyze, (text) =>
        this.runBounded(client, text, params),
      );
      return { ...result, durationMs: Date.now() - start, txnState: this.txnState };
    } finally {
      this.takeNotices();
    }
  }

  /** A read that failed because the transport died should say so (P1-1). */
  private asLossIfLost(err: unknown): unknown {
    if (this.lostReason && !(err instanceof ConnectionLostError) && !isServerError(err)) {
      return new ConnectionLostError(this.lostReason);
    }
    return err;
  }

  /**
   * Close a cursor without ever waiting on a dead connection (P1-1).
   * pg-cursor's close() waits for ReadyForQuery, which a killed backend
   * or a dead socket never sends; bound it, and treat silence as a
   * lost connection so the query settles and recovery can run.
   */
  private async closeCursorBounded(client: ClientT, cursor: Cursor): Promise<void> {
    const state = (cursor as unknown as { state?: string }).state;
    const c = client as unknown as { _queryable?: boolean; _ending?: boolean };
    if (this.lostReason || state === 'done' || c._queryable === false || c._ending) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | undefined;
    const closed = await Promise.race([
      new Promise<boolean>((resolve) => {
        try {
          cursor.close(() => resolve(true));
        } catch {
          resolve(true);
        }
      }),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), this.closeTimeoutMs);
      }),
      new Promise<boolean>((resolve) => {
        wake = () => resolve(true);
        this.lostWaiters.add(wake);
      }),
    ]);
    clearTimeout(timer);
    if (wake) this.lostWaiters.delete(wake);
    if (!closed) this.markConnectionLost('cursor close unanswered');
  }

  /**
   * Shared cursor read with row/byte caps. Emits chunks when `onChunk` is set.
   */
  private async runBounded(
    client: ClientT,
    sql: string,
    params: unknown[] | undefined,
    opts?: QueryOpts,
  ): Promise<Omit<QueryResult, 'durationMs'>> {
    const cursor = client.query(new Cursor(sql, params ?? [], { rowMode: 'array' }));
    const state = emptyBoundState();
    let columns: QueryResult['columns'] = [];
    let command: string | undefined;
    let commandRowCount: number | undefined;
    let chunkIndex = 0;
    const maxBytes = Math.min(opts?.maxBytes ?? MAX_RESULT_BYTES, MAX_RESULT_BYTES_CEILING);
    let wanted = FIRST_CURSOR_CHUNK;

    try {
      while (true) {
        const batch = await readCursorBatch(cursor, wanted);
        // Every answered batch proves the transport is alive, which is
        // what the idle probe in requireClient() keys off (U27).
        this.lastActivityAt = Date.now();
        if (columns.length === 0 && batch.fields.length > 0) {
          columns = batch.fields.map((f) => ({
            name: f.name,
            dataTypeID: f.dataTypeID,
            dataTypeName: pgTypeName(f.dataTypeID),
          }));
        }
        if (batch.command) {
          command = batch.command;
          // INSERT / UPDATE / DELETE return no rows; the tag carries the count.
          commandRowCount = batch.rowCount;
        }

        const before = state.rows.length;
        const stop = appendBoundedRows(
          state,
          batch.rows,
          Math.min(opts?.maxRows ?? MAX_RESULT_ROWS, opts?.rowCeiling ?? MAX_RESULT_ROWS),
          maxBytes,
        );
        const accepted = state.rows.length - before;
        const chunkRows = accepted > 0 ? batch.rows.slice(0, accepted) : [];

        if (opts?.onChunk && (chunkRows.length > 0 || chunkIndex === 0)) {
          opts.onChunk({
            rows: chunkRows,
            columns: chunkIndex === 0 ? columns : undefined,
            chunkIndex,
            done: false,
            truncated: state.truncated,
          });
        }
        chunkIndex++;

        if (stop || batch.rows.length === 0 || batch.rows.length < wanted) {
          break;
        }
        // P2-3: size the next read from what rows actually weigh, so wide
        // rows can't pile up 500 at a time before the byte cap is checked.
        wanted = nextCursorChunk(batch.rows);
      }
    } catch (err) {
      // A server error is an answer: the transport is alive (SC-03).
      if (isServerError(err)) this.lastActivityAt = Date.now();
      throw this.asLossIfLost(err);
    } finally {
      await this.closeCursorBounded(client, cursor);
    }
    if (columns.length > 0) {
      await this.resolveColumnTypeNames(columns, client === this.aux ? client : undefined);
    }

    if (opts?.onChunk) {
      opts.onChunk({
        rows: [],
        chunkIndex,
        done: true,
        truncated: state.truncated,
      });
    }

    return {
      columns,
      rows: state.rows,
      rowCount:
        columns.length === 0 && commandRowCount !== undefined ? commandRowCount : state.rows.length,
      command,
      truncated: state.truncated,
    };
  }

  /**
   * Cancel an in-flight query on the primary connection by sending
   * `pg_cancel_backend(pid)` from the dedicated control client (U19).
   */
  async cancelQuery(): Promise<boolean> {
    if (!this.control || this.primaryBackendPid === null) return false;
    // Cancel is racy by nature: if the statement already finished, the
    // signal would hit whatever runs next. Nothing in flight, nothing to do.
    if (!hasInflightQuery(this.primary)) return false;
    return this.cancelBackend(this.control, this.primaryBackendPid, 'primary');
  }

  /**
   * pg_cancel_backend from the control session, bounded: on a half-open
   * network (exactly when Cancel gets pressed) the control socket would
   * otherwise hang too. An unanswered cancel means the transport is gone.
   */
  private async cancelBackend(control: ClientT, pid: number, which: string): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answer = control.query<{ ok: boolean }>('SELECT pg_cancel_backend($1) AS ok', [pid]);
    answer.catch(() => {});
    try {
      const res = await Promise.race([
        answer,
        new Promise<never>((_r, reject) => {
          timer = setTimeout(
            () => reject(new Error(`no answer in ${this.cancelTimeoutMs}ms`)),
            this.cancelTimeoutMs,
          );
        }),
      ]);
      if (res.rows[0]?.ok === true) return true;
      throw new CancelFailedError('the server refused pg_cancel_backend');
    } catch (err) {
      if (err instanceof CancelFailedError) throw err;
      if (!isServerError(err)) this.markConnectionLost(`cancel (${which}) unanswered`);
      console.error(`[plasma] pg_cancel_backend (${which}) failed:`, err);
      throw new CancelFailedError(err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * C30: cancel the statement running on the aux connection (an AI tool
   * query, a monitor lookup). The control connection issues it, so it never
   * queues behind the work it is stopping.
   */
  async cancelAux(): Promise<boolean> {
    if (!this.control || this.auxBackendPid === null) return false;
    if (!hasInflightQuery(this.aux)) return false;
    return this.cancelBackend(this.control, this.auxBackendPid, 'aux');
  }

  /**
   * Unbounded cursor stream for worker-backed export (U16).
   * Does not apply display caps — yields batches until the server is done.
   * Caller must not retain all batches in memory.
   */
  async *streamQueryForExport(
    sql: string,
    params?: unknown[],
  ): AsyncGenerator<{ columns: QueryResult['columns']; rows: unknown[][] }, void, void> {
    this.assertNoSafeRun();
    const client = await this.requireClient('primary');
    await this.guardReadOnly(client, sql, this.txnStatus());
    const cursor = client.query(new Cursor(sql, params ?? [], { rowMode: 'array' }));
    let columns: QueryResult['columns'] = [];
    let first = true;
    let wanted = FIRST_CURSOR_CHUNK;
    try {
      while (true) {
        const batch = await readCursorBatch(cursor, wanted);
        this.lastActivityAt = Date.now();
        if (columns.length === 0 && batch.fields.length > 0) {
          columns = batch.fields.map((f) => ({
            name: f.name,
            dataTypeID: f.dataTypeID,
            dataTypeName: pgTypeName(f.dataTypeID),
          }));
          await this.resolveColumnTypeNames(columns);
        }
        // Always yield the first batch so an empty result still exports
        // its header / column list.
        if (batch.rows.length === 0 && !first) break;
        first = false;
        yield { columns, rows: batch.rows };
        if (batch.rows.length < wanted) break;
        wanted = nextCursorChunk(batch.rows);
      }
    } catch (err) {
      throw this.asLossIfLost(err);
    } finally {
      await this.closeCursorBounded(client, cursor);
    }
  }

  // ── Explicit transaction control (used by the Txn UI in the renderer) ──

  async beginTransaction(): Promise<TxnState> {
    this.assertNoSafeRun();
    const client = await this.requireClient('primary');
    await client.query('BEGIN');
    this.lastActivityAt = Date.now();
    return this.txnState;
  }

  async commitTransaction(): Promise<TxnState> {
    this.assertNoSafeRun();
    const client = await this.requireClient('primary');
    await client.query('COMMIT');
    this.lastActivityAt = Date.now();
    return this.txnState;
  }

  async rollbackTransaction(): Promise<TxnState> {
    this.assertNoSafeRun();
    const client = await this.requireClient('primary');
    await client.query('ROLLBACK');
    this.lastActivityAt = Date.now();
    return this.txnState;
  }

  // ── Safe Run (see pg-safe-run.ts) ──

  private assertNoSafeRun(): void {
    if (this.safeRun) throw new Error(SAFE_RUN_BLOCKED_MESSAGE);
  }

  /** The Safe Run is over without a finish call (connection gone, new session). */
  private dropSafeRun(reason: 'disconnect' | 'timeout'): void {
    const pending = this.safeRun;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.safeRun = null;
    this.lastSafeRunEnd = {
      runId: pending.runId,
      outcome: 'rolledBack',
      reason,
      txnState: 'none',
    };
  }

  /** Cursor read that keeps the first `cap` rows and only counts the rest. */
  private async readCapped(client: ClientT, sql: string, cap: number): Promise<CappedRead> {
    const cursor = client.query(new Cursor(sql, [], { rowMode: 'array' }));
    const state = emptyBoundState();
    let columns: QueryResult['columns'] = [];
    let total = 0;
    let exact = true;
    let commandRowCount: number | undefined;
    let wanted = FIRST_CURSOR_CHUNK;
    try {
      while (true) {
        const batch = await readCursorBatch(cursor, wanted);
        this.lastActivityAt = Date.now();
        if (columns.length === 0 && batch.fields.length > 0) {
          columns = batch.fields.map((f) => ({
            name: f.name,
            dataTypeID: f.dataTypeID,
            dataTypeName: pgTypeName(f.dataTypeID),
          }));
        }
        if (batch.command) commandRowCount = batch.rowCount;
        total += batch.rows.length;
        if (!state.truncated) appendBoundedRows(state, batch.rows, cap, MAX_RESULT_BYTES);
        if (batch.rows.length === 0 || batch.rows.length < wanted) break;
        if (total >= SAFE_RUN_COUNT_CEILING) {
          exact = false;
          break;
        }
        wanted = nextCursorChunk(batch.rows);
      }
    } catch (err) {
      if (isServerError(err)) this.lastActivityAt = Date.now();
      throw this.asLossIfLost(err);
    } finally {
      await this.closeCursorBounded(client, cursor);
    }
    if (columns.length > 0) await this.resolveColumnTypeNames(columns);
    return { columns, rows: state.rows, total, exact, commandRowCount };
  }

  /**
   * Run one write inside a held-open transaction (a savepoint when the
   * user already has one) and report what it changed. The transaction
   * stays open until `safeRunFinish`, or `timeoutSec`, after which the
   * worker rolls it back by itself.
   */
  async safeRunStart(
    runId: string,
    sql: string,
    opts: { connectionGen: number; timeoutSec: number; explain: boolean },
  ): Promise<SafeRunReport> {
    this.assertNoSafeRun();
    const client = await this.requireClient('primary');
    if (opts.connectionGen !== this.connectionGen) {
      throw new Error(
        `connection generation mismatch: Safe Run is for generation ${opts.connectionGen}, current is ${this.connectionGen}`,
      );
    }
    if (this.readOnlySession) {
      throw new Error(
        'Read-only connection: Safe Run is not allowed. Edit the connection to turn off read-only.',
      );
    }
    await this.guardReadOnly(client, sql, this.txnStatus());
    this.lastSafeRunEnd = null;
    this.takeNotices();
    // Claim the primary before the first await so nothing can slip in.
    const claim: PendingSafeRun = {
      runId,
      nested: this.txnStatus() === 'T',
      expiresAt: 0,
      timeoutSec: opts.timeoutSec,
      timer: undefined,
      ending: false,
      undoing: false,
      script: null,
    };
    this.safeRun = claim;
    try {
      const plan = planSafeRunScript(sql);
      const scripted = plan.ok ? plan.statements.length > 1 : this.looksLikeScript(sql);
      const deps = {
        query: (text: string, values?: unknown[]) => client.query(text, values),
        readCapped: (text: string, cap: number) => this.readCapped(client, text, cap),
        status: this.txnStatus(),
        takeNotices: () => this.takeNotices().map((n) => n.message),
      };
      let body: SafeRunBody;
      if (scripted) {
        // A script that does not qualify is refused with the statement number
        // before anything executes (planSafeRunScript throws inside).
        const started = await startSafeRunScript(deps, { runId, sql, explain: opts.explain });
        claim.nested = started.nested;
        claim.script = started.state;
        body = scriptReportBody(runId, started.nested, started.state);
      } else {
        const started = await startSafeRun(deps, { runId, sql, explain: opts.explain });
        claim.nested = started.nested;
        body = started.body;
      }
      claim.expiresAt = Date.now() + opts.timeoutSec * 1000;
      claim.timer = setTimeout(() => void this.expireSafeRun(runId), opts.timeoutSec * 1000);
      this.lastActivityAt = Date.now();
      return {
        ...body,
        expiresAt: claim.expiresAt,
        timeoutSec: opts.timeoutSec,
        txnState: this.txnState,
      };
    } catch (err) {
      if (this.safeRun === claim) this.safeRun = null;
      throw err;
    } finally {
      this.takeNotices();
    }
  }

  /** More than one statement by the splitter, whatever the validator says. */
  private looksLikeScript(sql: string): boolean {
    return splitSqlStatementRanges(sql).length > 1;
  }

  private async expireSafeRun(runId: string): Promise<void> {
    const pending = this.safeRun;
    if (!pending || pending.runId !== runId || pending.ending) return;
    pending.ending = true;
    const client = this.primary;
    try {
      if (client) await rollbackSafeRun({ query: (t) => client.query(t) }, pending.nested);
    } catch {
      // The connection died; the server already rolled the work back.
    }
    if (this.safeRun === pending) {
      this.safeRun = null;
      this.lastSafeRunEnd = {
        runId,
        outcome: 'rolledBack',
        reason: 'timeout',
        txnState: this.txnState,
      };
    }
  }

  /**
   * Commit or roll back the pending Safe Run. After a timeout, reports that instead.
   * A script that stopped at a failed statement can only be committed with
   * `commitPartial`, which keeps the statements that succeeded.
   */
  async safeRunFinish(
    runId: string,
    action: 'commit' | 'commitPartial' | 'rollback',
  ): Promise<SafeRunOutcome> {
    const pending = this.safeRun;
    if (!pending || pending.runId !== runId) {
      const ended = this.lastSafeRunEnd;
      if (ended && ended.runId === runId) return { ...ended, txnState: this.txnState };
      throw new Error('No Safe Run is pending: it may have timed out or the connection changed.');
    }
    if (pending.ending) throw new Error('This Safe Run is already ending.');
    if (pending.undoing) throw new Error('This Safe Run is busy undoing a statement.');
    const failedAt = pending.script?.failedAt ?? null;
    if (action === 'commit' && failedAt !== null) {
      throw new Error(
        `The script stopped at statement ${failedAt}. Nothing was committed. Roll back, or commit only the statements that succeeded.`,
      );
    }
    if (action === 'commitPartial' && failedAt === null) {
      throw new Error('Only a script that stopped at a failed statement is committed in part.');
    }
    if (action !== 'rollback' && pending.script && doneSteps(pending.script).length === 0) {
      throw new Error('No statement is pending, so there is nothing to commit.');
    }
    pending.ending = true;
    clearTimeout(pending.timer);
    const client = await this.requireClient('primary');
    try {
      await finishSafeRun(
        { query: (t) => client.query(t) },
        pending.nested,
        action === 'rollback' ? 'rollback' : 'commit',
      );
    } finally {
      // A failed COMMIT (deferred constraint) ends the transaction and a
      // failed rollback means the connection is gone: nothing is pending.
      if (this.safeRun === pending) this.safeRun = null;
    }
    this.lastActivityAt = Date.now();
    return {
      runId,
      outcome: action === 'rollback' ? 'rolledBack' : 'committed',
      reason: 'user',
      txnState: this.txnState,
    };
  }

  /**
   * Script runs: roll back the last statement that ran, keep the earlier
   * ones pending, and return the updated report. Undoing the only statement
   * left is a roll back of the whole run (the outcome is returned instead).
   */
  async safeRunUndoLast(runId: string): Promise<SafeRunUndoResult> {
    const pending = this.safeRun;
    if (!pending || pending.runId !== runId) {
      throw new Error('No Safe Run is pending: it may have timed out or the connection changed.');
    }
    const script = pending.script;
    if (!script) throw new Error('Undo is for Safe Run scripts of several statements.');
    if (pending.ending || pending.undoing) throw new Error('This Safe Run is busy.');
    if (doneSteps(script).length === 0) throw new Error('There is no statement to undo.');
    if (doneSteps(script).length === 1) {
      const outcome = await this.safeRunFinish(runId, 'rollback');
      return { report: null, outcome };
    }
    // Stop the review timer while the savepoint is rolled back, then re-arm it for
    // the time that was left. A timeout that already started wins (checked above).
    pending.undoing = true;
    clearTimeout(pending.timer);
    const client = await this.requireClient('primary');
    try {
      await undoLastScriptStatement({ query: (t) => client.query(t) }, script);
    } finally {
      pending.undoing = false;
      if (this.safeRun === pending && !pending.ending) {
        const left = Math.max(0, pending.expiresAt - Date.now());
        pending.timer = setTimeout(() => void this.expireSafeRun(runId), left);
      }
    }
    this.lastActivityAt = Date.now();
    return {
      report: {
        ...scriptReportBody(runId, pending.nested, script),
        expiresAt: pending.expiresAt,
        timeoutSec: pending.timeoutSec,
        txnState: this.txnState,
      },
      outcome: null,
    };
  }

  setConnectionGen(gen: number): void {
    this.connectionGen = gen;
  }

  /**
   * Apply a grid edit batch atomically (C7/F4/F5). See runEditBatch: every
   * UPDATE must hit exactly one row; a user's open transaction gets a
   * SAVEPOINT and is never committed by the tray.
   */
  async commitEditBatch(
    expectedGen: number,
    updates: EditUpdate[],
  ): Promise<{ state: TxnState; applied: number; conflicts: EditBatchConflict[] }> {
    this.assertNoSafeRun();
    const client = await this.requireClient('primary');
    if (expectedGen !== this.connectionGen)
      throw new Error(
        `connection generation mismatch: edit batch is for generation ${expectedGen}, current is ${this.connectionGen}`,
      );
    this.takeNotices();
    let outcome: EditBatchOutcome;
    try {
      outcome = await runEditBatch(client, this.txnStatus(), updates);
    } finally {
      this.takeNotices();
    }
    this.lastActivityAt = Date.now();
    return { state: this.txnState, ...outcome };
  }

  /** Structure editor Apply (see pg-import.ts). */
  async applyDdl(req: DdlApplyRequest): Promise<DdlApplyResult> {
    this.assertNoSafeRun();
    const client = await this.requireClient('primary');
    if (req.connectionGen !== this.connectionGen)
      throw new Error(
        `connection generation mismatch: structure change is for generation ${req.connectionGen}, current is ${this.connectionGen}`,
      );
    this.takeNotices();
    let res: DdlApplyResult;
    try {
      res = await applyDdl(client, this.txnStatus(), req);
    } finally {
      this.takeNotices();
    }
    this.lastActivityAt = Date.now();
    return res;
  }

  /** Import a file into a table in one transaction (see pg-import.ts). */
  async runImport(job: ImportJobSpec, hooks: ImportHooks): Promise<ImportResult> {
    this.assertNoSafeRun();
    const client = await this.requireClient('primary');
    if (job.connectionGen !== this.connectionGen)
      throw new Error(
        `connection generation mismatch: import is for generation ${job.connectionGen}, current is ${this.connectionGen}`,
      );
    this.takeNotices();
    let res: ImportResult;
    try {
      res = await runImport(client, this.txnStatus(), job, hooks);
    } finally {
      this.takeNotices();
    }
    this.lastActivityAt = Date.now();
    return res;
  }

  async aiQuery(sql: string, params?: unknown[], opts?: AiQueryOpts): Promise<QueryResult> {
    if (!isSingleSqlStatement(sql))
      throw new Error('rejected: AI queries must be a single SQL statement');
    // F12: serialised with other aux work so a sideband lookup can't land
    // inside this read-only transaction (or vice versa).
    return this.withAux((client) => this.runAiQuery(client, sql, params, opts));
  }

  private async runAiQuery(
    client: ClientT,
    sql: string,
    params?: unknown[],
    opts?: AiQueryOpts,
  ): Promise<QueryResult> {
    const start = Date.now();
    try {
      // F19: one statement, so nothing can land between BEGIN and READ ONLY.
      await client.query('BEGIN READ ONLY');
      // C18: a model-written query must not hold the aux session forever.
      await client.query('SET LOCAL statement_timeout = 30000');
      const result = await this.runBounded(
        client,
        sql,
        params,
        opts?.maxRows ? { maxRows: opts.maxRows, rowCeiling: opts.maxRows } : undefined,
      );
      await client.query('COMMIT');
      return { ...result, durationMs: Date.now() - start };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {}
      throw err;
    }
  }

  async introspect(opts?: IntrospectOpts): Promise<SchemaInfo> {
    // Runs on the aux connection, not the primary: a refresh must not queue
    // behind a long user query (or fail inside an aborted user transaction),
    // and the sidebar's own catalog reads shouldn't disturb the primary's
    // transaction state.
    //
    // A `SET ROLE` (Session role panel) is issued on the primary only, so aux
    // keeps the login role. That is deliberate: the introspection queries
    // read pg_catalog / information_schema-style catalogs that every role can
    // SELECT, and none of them call has_*_privilege() or current_user, so the
    // object list is the same whichever role is set. Listing what the login
    // role sees also keeps the sidebar stable when a restricted role is
    // selected for testing. (If introspection ever starts filtering by
    // privilege, switch back to the primary when a role is set.)
    const info = await this.withAux((client) => introspectPostgres(client, opts));
    this.lastActivityAt = Date.now();
    return info;
  }
}
