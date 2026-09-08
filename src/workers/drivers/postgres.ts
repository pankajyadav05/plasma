import { ConnectionLostError } from '@shared/connection-loss';
import type { ConnectionConfig, PgNotice, QueryResult, SchemaInfo, TxnState } from '@shared/protocol';
import {
  RESULT_CURSOR_CHUNK,
  appendBoundedRows,
  emptyBoundState,
} from '@shared/result-bounds';
import pg from 'pg';
import Cursor from 'pg-cursor';
import { formatStatementTimeoutSql } from '@shared/worker-policy';
import { isSingleSqlStatement } from '@shared/sql-statements';

const { Client } = pg;
type ClientT = InstanceType<typeof Client>;
interface PgNoticeRaw { message?: string; severity?: string; name?: string; code?: string; detail?: string; hint?: string; where?: string; }
function toPgNotice(n: PgNoticeRaw): PgNotice { return { message: n.message ?? '', severity: n.severity || n.name || undefined, code: n.code || undefined, detail: n.detail || undefined, hint: n.hint || undefined, where: n.where || undefined }; }

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
};

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
        rowCount: result?.rowCount ?? (rows?.length ?? 0),
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
  private txnState: TxnState = 'none';
  private statementTimeoutMs = 0;
  private connectionGen = 0;
  /** Notices accumulated for the in-flight primary query (U26). */
  private pendingNotices: PgNotice[] = [];
  /** Optional fan-out so the worker can stream notices over the event channel. */
  private noticeListener: ((notice: PgNotice) => void) | null = null;
  /** Why the transport died, once known — reported to every later caller (U27). */
  private lostReason: string | null = null;
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

  private handleNotice = (raw: PgNoticeRaw): void => {
    const notice = toPgNotice(raw);
    this.pendingNotices.push(notice);
    this.noticeListener?.(notice);
  };

  isConnected(): boolean {
    return this.primary !== null;
  }

  getTxnState(): TxnState {
    return this.txnState;
  }

  private clientOpts(config: ConnectionConfig, application_name: string) {
    return {
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 10_000,
      // U27: without keepalive a VPN drop leaves an idle socket that
      // looks writable forever. The kernel probes and fails it instead.
      keepAlive: true,
      keepAliveInitialDelayMillis: KEEPALIVE_INITIAL_DELAY_MS,
      application_name,
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
    this.txnState = 'none';
    this.primaryBackendPid = null;
    this.pendingNotices = [];
    this.primary = null;
    this.control = null;
    this.aux = null;

    for (const client of clients) {
      if (!client) continue;
      client.removeListener('notice', this.handleNotice);
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

  async connect(config: ConnectionConfig, statementTimeoutMs?: number): Promise<string> {
    // Hang up any previous clients first
    await this.disconnect();

    if (statementTimeoutMs !== undefined) {
      this.statementTimeoutMs = Math.max(0, Math.floor(statementTimeoutMs));
    }

    const primary = new Client(this.clientOpts(config, 'plasma'));
    await primary.connect();
    // U26: capture RAISE NOTICE / server notices for the messages strip
    // and stream them to the worker's broadcast channel.
    primary.on('notice', this.handleNotice);
    this.attachLifecycle(primary, 'primary');
    this.primary = primary;

    // Grab the backend pid so control can cancel it
    const pidRes = await primary.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    this.primaryBackendPid = pidRes.rows[0]?.pid ?? null;

    // Control connection — cancel capacity only (U19)
    const control = new Client(this.clientOpts(config, 'plasma-control'));
    await control.connect();
    this.attachLifecycle(control, 'control');
    this.control = control;

    // Aux connection — AI / monitor execution budget, separate from cancel
    const aux = new Client(this.clientOpts(config, 'plasma-aux'));
    await aux.connect();
    this.attachLifecycle(aux, 'aux');
    this.aux = aux;

    await this.applyStatementTimeout();

    const res = await primary.query<{ version: string }>('SELECT version()');
    this.lastActivityAt = Date.now();
    return res.rows[0]?.version ?? 'unknown';
  }

  async disconnect(): Promise<void> {
    this.txnState = 'none';
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
    if (p) p.removeListener('notice', this.handleNotice);
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

    this.pendingNotices = [];
    const start = Date.now();
    const result = await this.runBounded(client, sql, params, opts);
    const durationMs = Date.now() - start;
    const notices = this.pendingNotices;
    this.pendingNotices = [];

    // BEGIN/COMMIT/ROLLBACK statements flow through this path too.
    const upper = sql.trim().toUpperCase();
    if (upper.startsWith('BEGIN') || upper.startsWith('START TRANSACTION')) {
      this.txnState = 'active';
    } else if (upper.startsWith('COMMIT') || upper.startsWith('ROLLBACK')) {
      this.txnState = 'none';
    }

    return { ...result, durationMs, notices: notices.length > 0 ? notices : undefined };
  }

  /**
   * Run a query on the aux connection (AI tools, live monitor,
   * pg_terminate_backend). Never touches the control cancel client (U19).
   *
   * Aux never participates in the primary's transaction state.
   */
  async sidebandQuery(sql: string, params?: unknown[], opts?: QueryOpts): Promise<QueryResult> {
    const client = await this.requireClient('aux');
    const start = Date.now();
    const result = await this.runBounded(client, sql, params, opts);
    return { ...result, durationMs: Date.now() - start };
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
        }
        if (batch.command) command = batch.command;

        const before = state.rows.length;
        const stop = appendBoundedRows(state, batch.rows);
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
      rowCount: state.rows.length,
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
   * Unbounded cursor stream for worker-backed export (U16).
   * Does not apply display caps — yields batches until the server is done.
   * Caller must not retain all batches in memory.
   */
  async *streamQueryForExport(
    sql: string,
    params?: unknown[],
  ): AsyncGenerator<{ columns: QueryResult["columns"]; rows: unknown[][] }, void, void> {
    const client = await this.requireClient('primary');
    const cursor = client.query(new Cursor(sql, params ?? [], { rowMode: "array" }));
    let columns: QueryResult["columns"] = [];
    try {
      while (true) {
        const batch = await readCursorBatch(cursor, RESULT_CURSOR_CHUNK);
        if (columns.length === 0 && batch.fields.length > 0) {
          columns = batch.fields.map((f) => ({
            name: f.name,
            dataTypeID: f.dataTypeID,
            dataTypeName: pgTypeName(f.dataTypeID),
          }));
        }
        if (batch.rows.length === 0) break;
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
    this.txnState = 'active';
    this.lastActivityAt = Date.now();
    return this.txnState;
  }

  async commitTransaction(): Promise<TxnState> {
    const client = await this.requireClient('primary');
    await client.query('COMMIT');
    this.txnState = 'none';
    this.lastActivityAt = Date.now();
    return this.txnState;
  }

  async rollbackTransaction(): Promise<TxnState> {
    const client = await this.requireClient('primary');
    await client.query('ROLLBACK');
    this.txnState = 'none';
    this.lastActivityAt = Date.now();
    return this.txnState;
  }

  setConnectionGen(gen: number): void { this.connectionGen = gen; }

  async commitEditBatch(expectedGen: number, updates: Array<{ sql: string; params?: unknown[] }>): Promise<TxnState> {
    const client = await this.requireClient('primary');
    if (expectedGen !== this.connectionGen) throw new Error(`connection generation mismatch: edit batch is for generation ${expectedGen}, current is ${this.connectionGen}`);
    const savepoint = this.txnState === "active";
    if (savepoint) await client.query("SAVEPOINT plasma_edit_batch"); else await client.query("BEGIN");
    try {
      for (const update of updates) await client.query({ text: update.sql, values: update.params });
      if (savepoint) await client.query("RELEASE SAVEPOINT plasma_edit_batch"); else await client.query("COMMIT");
      this.lastActivityAt = Date.now();
      return this.txnState;
    } catch (err) {
      try { await client.query(savepoint ? "ROLLBACK TO SAVEPOINT plasma_edit_batch" : "ROLLBACK"); } catch {}
      throw err;
    }
  }

  async aiQuery(sql: string, params?: unknown[]): Promise<QueryResult> {
    const client = await this.requireClient('aux');
    if (!isSingleSqlStatement(sql)) throw new Error("rejected: AI queries must be a single SQL statement");
    const start = Date.now();
    try {
      await client.query("BEGIN");
      await client.query("SET TRANSACTION READ ONLY");
      const result = await this.runBounded(client, sql, params);
      await client.query("COMMIT");
      return { ...result, durationMs: Date.now() - start };
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch {}
      throw err;
    }
  }

  async introspect(): Promise<SchemaInfo> {
    const client = await this.requireClient('primary');

    // IMPORTANT: pg.Client serializes queries internally but DOES warn
    // (and in pg@9 will error) if you call .query() while another is
    // in-flight. Run these sequentially, not via Promise.all.
    const schemas = await client.query<{ schema_name: string }>(
      `SELECT nspname AS schema_name
       FROM pg_namespace
       WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
         AND nspname NOT LIKE 'pg_temp_%'
         AND nspname NOT LIKE 'pg_toast_temp_%'
       ORDER BY nspname`,
    );
    const tables = await client.query<{
      schema: string;
      name: string;
      kind: 'r' | 'v' | 'm' | 'f' | 'p';
      row_count: string | null;
    }>(
      `SELECT n.nspname AS schema,
              c.relname  AS name,
              c.relkind  AS kind,
              NULLIF(c.reltuples, -1)::bigint::text AS row_count
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'v', 'm', 'f', 'p')
         AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
         AND n.nspname NOT LIKE 'pg_temp_%'
       ORDER BY n.nspname, c.relname`,
    );
    const columns = await client.query<{
      schema: string;
      table: string;
      name: string;
      data_type: string;
      ordinal: number;
      is_pk: boolean;
      is_nullable: boolean;
      has_default: boolean;
    }>(
      `SELECT n.nspname AS schema,
              c.relname  AS "table",
              a.attname  AS name,
              format_type(a.atttypid, a.atttypmod) AS data_type,
              a.attnum   AS ordinal,
              COALESCE(pk.is_pk, false) AS is_pk,
              NOT a.attnotnull AS is_nullable,
              a.atthasdef AS has_default
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN LATERAL (
         SELECT true AS is_pk
         FROM pg_constraint con
         WHERE con.conrelid = c.oid
           AND con.contype = 'p'
           AND a.attnum = ANY (con.conkey)
         LIMIT 1
       ) pk ON true
       WHERE a.attnum > 0
         AND NOT a.attisdropped
         AND c.relkind IN ('r', 'v', 'm', 'f', 'p')
         AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
         AND n.nspname NOT LIKE 'pg_temp_%'
       ORDER BY n.nspname, c.relname, a.attnum`,
    );

    // Foreign keys — one row per FK column. `unnest` with WITH ORDINALITY
    // pairs each `conkey` index to its matching `confkey` index so a
    // composite FK (two columns) yields two rows sharing a constraint
    // oid. Filters to system schemas are the same as above.
    const foreignKeys = await client.query<{
      schema: string;
      table: string;
      column: string;
      ref_schema: string;
      ref_table: string;
      ref_column: string;
    }>(
      `SELECT n.nspname   AS schema,
              c.relname   AS "table",
              a.attname   AS column,
              fn.nspname  AS ref_schema,
              fc.relname  AS ref_table,
              fa.attname  AS ref_column
       FROM pg_constraint con
       JOIN pg_class     c  ON c.oid  = con.conrelid
       JOIN pg_namespace n  ON n.oid  = c.relnamespace
       JOIN pg_class     fc ON fc.oid = con.confrelid
       JOIN pg_namespace fn ON fn.oid = fc.relnamespace
       JOIN LATERAL unnest(con.conkey)  WITH ORDINALITY AS k(attnum, ord) ON true
       JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS fk(attnum, ord) ON fk.ord = k.ord
       JOIN pg_attribute a  ON a.attrelid  = c.oid  AND a.attnum  = k.attnum
       JOIN pg_attribute fa ON fa.attrelid = fc.oid AND fa.attnum = fk.attnum
       WHERE con.contype = 'f'
         AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
         AND n.nspname NOT LIKE 'pg_temp_%'
       ORDER BY n.nspname, c.relname, a.attnum`,
    );
    this.lastActivityAt = Date.now();

    const kindMap = {
      r: 'table',
      v: 'view',
      m: 'matview',
      f: 'foreign',
      p: 'partitioned',
    } as const;

    return {
      schemas: schemas.rows.map((r) => ({ name: r.schema_name })),
      tables: tables.rows.map((r) => ({
        schema: r.schema,
        name: r.name,
        kind: kindMap[r.kind],
        rowCountEstimate: r.row_count !== null ? Number(r.row_count) : null,
      })),
      columns: columns.rows.map((r) => ({
        schema: r.schema,
        table: r.table,
        name: r.name,
        dataType: r.data_type,
        ordinal: r.ordinal,
        isPrimaryKey: r.is_pk,
        isNullable: r.is_nullable,
        hasDefault: r.has_default,
      })),
      foreignKeys: foreignKeys.rows.map((r) => ({
        schema: r.schema,
        table: r.table,
        column: r.column,
        refSchema: r.ref_schema,
        refTable: r.ref_table,
        refColumn: r.ref_column,
      })),
    };
  }
}

function pgTypeName(oid: number): string {
  const map: Record<number, string> = {
    16: 'bool',
    17: 'bytea',
    20: 'int8',
    21: 'int2',
    23: 'int4',
    25: 'text',
    114: 'json',
    700: 'float4',
    701: 'float8',
    1043: 'varchar',
    1082: 'date',
    1083: 'time',
    1114: 'timestamp',
    1184: 'timestamptz',
    1186: 'interval',
    1700: 'numeric',
    2950: 'uuid',
    3802: 'jsonb',
  };
  return map[oid] ?? `oid:${oid}`;
}
