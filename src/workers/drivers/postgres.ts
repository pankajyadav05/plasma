import { ConnectionLostError } from '@shared/connection-loss';
import { pgTypeName } from '@shared/pg-type-oids';
import type {
  ConnectionConfig,
  IntrospectOpts,
  PgNotice,
  QueryResult,
  SchemaInfo,
  TxnState,
} from '@shared/protocol';
import type {
  DdlApplyRequest,
  DdlApplyResult,
  ImportJobSpec,
  ImportResult,
} from '@shared/protocol';
import {
  MAX_RESULT_ROWS,
  RESULT_CURSOR_CHUNK,
  appendBoundedRows,
  emptyBoundState,
} from '@shared/result-bounds';
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
import {
  type EditUpdate,
  type TxnStatus,
  runEditBatch,
  runExplain,
  txnStateFromStatus,
} from './pg-txn';
import { plasmaPgTypes } from './pg-type-parsers';
import { introspectPostgres } from './postgres-introspect';

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
};

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

async function closeCursor(cursor: Cursor): Promise<void> {
  await new Promise<void>((resolve) => {
    try {
      cursor.close(() => resolve());
    } catch {
      resolve();
    }
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
export class PostgresDriver {
  private primary: ClientT | null = null;
  private control: ClientT | null = null;
  private aux: ClientT | null = null;
  private primaryBackendPid: number | null = null;
  private auxBackendPid: number | null = null;
  private txnState: TxnState = 'none';
  private statementTimeoutMs = 0;
  private connectionGen = 0;
  /** Notices accumulated for the in-flight primary query (U26). */
  private pendingNotices: PgNotice[] = [];
  /** Optional fan-out so the worker can stream notices over the event channel. */
  private noticeListener: ((notice: PgNotice) => void) | null = null;
  /** Why the transport died, once known — reported to every later caller (U27). */
  private lostReason: string | null = null;
  /** The transport died while a user transaction was open (C5). */
  private lostInTxn = false;
  /** Timestamp of the last statement the server actually answered (U27). */
  private lastActivityAt = 0;
  private readonly idleProbeAfterMs: number;
  private readonly probeTimeoutMs: number;

  constructor(liveness?: PostgresLivenessOptions) {
    this.idleProbeAfterMs = liveness?.idleProbeAfterMs ?? IDLE_PROBE_AFTER_MS;
    this.probeTimeoutMs = liveness?.probeTimeoutMs ?? LIVENESS_PROBE_TIMEOUT_MS;
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

  /**
   * Replace `oid:NNNN` column type names with the server's own name
   * (`order_status`, `public.money_amount`…). Looked up on the aux
   * connection so it never runs inside the user's transaction; any failure
   * leaves the placeholder, which the renderer still shows.
   */
  private async resolveColumnTypeNames(columns: QueryResult['columns']): Promise<void> {
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
        const res = await this.withAux((client) =>
          client.query<{ oid: number; name: string }>(
            'SELECT oid::int AS oid, format_type(oid, NULL) AS name FROM pg_type WHERE oid = ANY($1::oid[])',
            [unknown],
          ),
        );
        for (const r of res.rows) this.customTypeNames.set(Number(r.oid), r.name);
      } catch {
        return;
      }
    }
    for (const c of columns) {
      const name = this.customTypeNames.get(c.dataTypeID);
      if (name && c.dataTypeName?.startsWith('oid:')) c.dataTypeName = name;
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
    this.primaryBackendPid = null;
    this.auxBackendPid = null;
    this.pendingNotices = [];
    this.primary = null;
    this.control = null;
    this.aux = null;
    this.customTypeNames.clear();

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
    if (Date.now() - this.lastActivityAt < this.idleProbeAfterMs) return client;
    await this.probe(client, role);
    if (this.lostReason) throw new ConnectionLostError(this.lostReason);
    return client;
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

      // C28: per-connection bootstrap SQL (search_path, time zone, role…).
      await runBootstrapSql(primary, config.bootstrapSql);

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
    this.lostInTxn = false;
    this.primaryBackendPid = null;
    this.pendingNotices = [];
    this.lostReason = null;
    this.lastActivityAt = 0;
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
    await Promise.allSettled([p?.end(), c?.end(), a?.end()]);
  }

  /**
   * Apply `queryTimeoutMs` as PostgreSQL `statement_timeout` on primary + aux.
   * Control is left alone so cancel is never delayed by a session timeout (U20).
   */
  async setStatementTimeout(timeoutMs: number): Promise<void> {
    this.statementTimeoutMs = Math.max(0, Math.floor(timeoutMs));
    await this.applyStatementTimeout();
  }

  private async applyStatementTimeout(): Promise<void> {
    const sql = formatStatementTimeoutSql(this.statementTimeoutMs);
    if (this.primary) await this.primary.query(sql);
    if (this.aux) await this.aux.query(sql);
  }

  /**
   * Run SQL on the primary connection with pg-cursor bounded reads (U15).
   * Stops at MAX_RESULT_ROWS / MAX_RESULT_BYTES and sets `truncated`.
   * Optional `onChunk` emits cursor batches for the event channel (step 2).
   */
  async query(sql: string, params?: unknown[], opts?: QueryOpts): Promise<QueryResult> {
    const client = await this.requireClient('primary');

    // F9: Transaction mode — open a transaction before the first statement
    // of a unit of work, unless the statement manages transactions itself
    // or cannot run inside one (VACUUM, CREATE INDEX CONCURRENTLY, …).
    if (opts?.autoBegin && this.txnStatus() === 'I' && !isTxnExemptSql(sql)) {
      await client.query('BEGIN');
    }

    this.pendingNotices = [];
    this.droppedNotices = 0;
    const start = Date.now();
    const result = await this.runBounded(client, sql, params, opts);
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
  async explain(sql: string, analyze: boolean): Promise<QueryResult> {
    const client = await this.requireClient('primary');
    const start = Date.now();
    const result = await runExplain(client, this.txnStatus(), sql, analyze, (text) =>
      this.runBounded(client, text, undefined),
    );
    return { ...result, durationMs: Date.now() - start, txnState: this.txnState };
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

    try {
      while (true) {
        const batch = await readCursorBatch(cursor, RESULT_CURSOR_CHUNK);
        // Every answered batch proves the transport is alive, which is
        // what the idle probe in requireClient() keys off (U27).
        this.lastActivityAt = Date.now();
        if (columns.length === 0 && batch.fields.length > 0) {
          columns = batch.fields.map((f) => ({
            name: f.name,
            dataTypeID: f.dataTypeID,
            dataTypeName: pgTypeName(f.dataTypeID),
          }));
          await this.resolveColumnTypeNames(columns);
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
          Math.min(opts?.maxRows ?? MAX_RESULT_ROWS, MAX_RESULT_ROWS),
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

        if (stop || batch.rows.length === 0 || batch.rows.length < RESULT_CURSOR_CHUNK) {
          break;
        }
      }
    } finally {
      await closeCursor(cursor);
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
  async cancelQuery(): Promise<void> {
    if (!this.control || this.primaryBackendPid === null) return;
    try {
      await this.control.query('SELECT pg_cancel_backend($1)', [this.primaryBackendPid]);
    } catch (err) {
      // If cancellation itself fails, log but don't throw — the
      // primary will either finish naturally or time out.
      console.error('[plasma] pg_cancel_backend failed:', err);
    }
  }

  /**
   * C30: cancel the statement running on the aux connection (an AI tool
   * query, a monitor lookup). The control connection issues it, so it never
   * queues behind the work it is stopping.
   */
  async cancelAux(): Promise<void> {
    if (!this.control || this.auxBackendPid === null) return;
    try {
      await this.control.query('SELECT pg_cancel_backend($1)', [this.auxBackendPid]);
    } catch (err) {
      console.error('[plasma] pg_cancel_backend (aux) failed:', err);
    }
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
    const client = await this.requireClient('primary');
    const cursor = client.query(new Cursor(sql, params ?? [], { rowMode: 'array' }));
    let columns: QueryResult['columns'] = [];
    let first = true;
    try {
      while (true) {
        const batch = await readCursorBatch(cursor, RESULT_CURSOR_CHUNK);
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
        if (batch.rows.length < RESULT_CURSOR_CHUNK) break;
      }
    } finally {
      await closeCursor(cursor);
    }
  }

  // ── Explicit transaction control (used by the Txn UI in the renderer) ──

  async beginTransaction(): Promise<TxnState> {
    const client = await this.requireClient('primary');
    await client.query('BEGIN');
    this.lastActivityAt = Date.now();
    return this.txnState;
  }

  async commitTransaction(): Promise<TxnState> {
    const client = await this.requireClient('primary');
    await client.query('COMMIT');
    this.lastActivityAt = Date.now();
    return this.txnState;
  }

  async rollbackTransaction(): Promise<TxnState> {
    const client = await this.requireClient('primary');
    await client.query('ROLLBACK');
    this.lastActivityAt = Date.now();
    return this.txnState;
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
  ): Promise<{ state: TxnState; applied: number }> {
    const client = await this.requireClient('primary');
    if (expectedGen !== this.connectionGen)
      throw new Error(
        `connection generation mismatch: edit batch is for generation ${expectedGen}, current is ${this.connectionGen}`,
      );
    const applied = await runEditBatch(client, this.txnStatus(), updates);
    this.lastActivityAt = Date.now();
    return { state: this.txnState, applied };
  }

  /** Structure editor Apply (see pg-import.ts). */
  async applyDdl(req: DdlApplyRequest): Promise<DdlApplyResult> {
    const client = await this.requireClient('primary');
    if (req.connectionGen !== this.connectionGen)
      throw new Error(
        `connection generation mismatch: structure change is for generation ${req.connectionGen}, current is ${this.connectionGen}`,
      );
    const res = await applyDdl(client, this.txnStatus(), req);
    this.lastActivityAt = Date.now();
    return res;
  }

  /** Import a file into a table in one transaction (see pg-import.ts). */
  async runImport(job: ImportJobSpec, hooks: ImportHooks): Promise<ImportResult> {
    const client = await this.requireClient('primary');
    if (job.connectionGen !== this.connectionGen)
      throw new Error(
        `connection generation mismatch: import is for generation ${job.connectionGen}, current is ${this.connectionGen}`,
      );
    const res = await runImport(client, this.txnStatus(), job, hooks);
    this.lastActivityAt = Date.now();
    return res;
  }

  async aiQuery(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (!isSingleSqlStatement(sql))
      throw new Error('rejected: AI queries must be a single SQL statement');
    // F12: serialised with other aux work so a sideband lookup can't land
    // inside this read-only transaction (or vice versa).
    return this.withAux((client) => this.runAiQuery(client, sql, params));
  }

  private async runAiQuery(client: ClientT, sql: string, params?: unknown[]): Promise<QueryResult> {
    const start = Date.now();
    try {
      // F19: one statement, so nothing can land between BEGIN and READ ONLY.
      await client.query('BEGIN READ ONLY');
      // C18: a model-written query must not hold the aux session forever.
      await client.query('SET LOCAL statement_timeout = 30000');
      const result = await this.runBounded(client, sql, params);
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
