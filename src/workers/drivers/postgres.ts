import type { ConnectionConfig, QueryResult, SchemaInfo, TxnState } from '@shared/protocol';
import { formatStatementTimeoutSql } from '@shared/worker-policy';
import pg from 'pg';

const { Client } = pg;
type ClientT = InstanceType<typeof Client>;

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
      application_name,
    };
  }

  async connect(config: ConnectionConfig, statementTimeoutMs?: number): Promise<string> {
    // Hang up any previous clients first
    await this.disconnect();

    if (statementTimeoutMs !== undefined) {
      this.statementTimeoutMs = Math.max(0, Math.floor(statementTimeoutMs));
    }

    const primary = new Client(this.clientOpts(config, 'plasma'));
    await primary.connect();
    this.primary = primary;

    // Grab the backend pid so control can cancel it
    const pidRes = await primary.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    this.primaryBackendPid = pidRes.rows[0]?.pid ?? null;

    // Control connection — cancel capacity only (U19)
    const control = new Client(this.clientOpts(config, 'plasma-control'));
    await control.connect();
    this.control = control;

    // Aux connection — AI / monitor execution budget, separate from cancel
    const aux = new Client(this.clientOpts(config, 'plasma-aux'));
    await aux.connect();
    this.aux = aux;

    await this.applyStatementTimeout();

    const res = await primary.query<{ version: string }>('SELECT version()');
    return res.rows[0]?.version ?? 'unknown';
  }

  async disconnect(): Promise<void> {
    this.txnState = 'none';
    this.primaryBackendPid = null;
    const p = this.primary;
    const c = this.control;
    const a = this.aux;
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

  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (!this.primary) throw new Error('not connected');

    const start = Date.now();
    // rowMode:'array' returns positional tuples instead of objects —
    // cheaper to serialize across IPC and handles duplicate column names.
    const res = await this.primary.query({
      text: sql,
      values: params,
      rowMode: 'array',
    });
    const durationMs = Date.now() - start;

    // Any query error would have thrown above. If we got here without an
    // error but had been in an active txn, state stays 'active'. BEGIN/COMMIT/
    // ROLLBACK statements flow through this path too — update state if so.
    const upper = sql.trim().toUpperCase();
    if (upper.startsWith('BEGIN') || upper.startsWith('START TRANSACTION')) {
      this.txnState = 'active';
    } else if (upper.startsWith('COMMIT') || upper.startsWith('ROLLBACK')) {
      this.txnState = 'none';
    }

    return {
      columns: res.fields.map((f) => ({
        name: f.name,
        dataTypeID: f.dataTypeID,
        dataTypeName: pgTypeName(f.dataTypeID),
      })),
      rows: res.rows as unknown[][],
      rowCount: res.rowCount ?? res.rows.length,
      durationMs,
      command: res.command,
    };
  }

  /**
   * Run a query on the aux connection (AI tools, live monitor,
   * pg_terminate_backend). Never touches the control cancel client (U19).
   *
   * Aux never participates in the primary's transaction state.
   */
  async sidebandQuery(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (!this.aux) throw new Error('not connected');
    const start = Date.now();
    const res = await this.aux.query({
      text: sql,
      values: params,
      rowMode: 'array',
    });
    const durationMs = Date.now() - start;
    return {
      columns: res.fields.map((f) => ({
        name: f.name,
        dataTypeID: f.dataTypeID,
        dataTypeName: pgTypeName(f.dataTypeID),
      })),
      rows: res.rows as unknown[][],
      rowCount: res.rowCount ?? res.rows.length,
      durationMs,
      command: res.command,
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

  // ── Explicit transaction control (used by the Txn UI in the renderer) ──

  async beginTransaction(): Promise<TxnState> {
    if (!this.primary) throw new Error('not connected');
    await this.primary.query('BEGIN');
    this.txnState = 'active';
    return this.txnState;
  }

  async commitTransaction(): Promise<TxnState> {
    if (!this.primary) throw new Error('not connected');
    await this.primary.query('COMMIT');
    this.txnState = 'none';
    return this.txnState;
  }

  async rollbackTransaction(): Promise<TxnState> {
    if (!this.primary) throw new Error('not connected');
    await this.primary.query('ROLLBACK');
    this.txnState = 'none';
    return this.txnState;
  }

  async introspect(): Promise<SchemaInfo> {
    if (!this.primary) throw new Error('not connected');

    // IMPORTANT: pg.Client serializes queries internally but DOES warn
    // (and in pg@9 will error) if you call .query() while another is
    // in-flight. Run these sequentially, not via Promise.all.
    const schemas = await this.primary.query<{ schema_name: string }>(
      `SELECT nspname AS schema_name
       FROM pg_namespace
       WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
         AND nspname NOT LIKE 'pg_temp_%'
         AND nspname NOT LIKE 'pg_toast_temp_%'
       ORDER BY nspname`,
    );
    const tables = await this.primary.query<{
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
    const columns = await this.primary.query<{
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
    const foreignKeys = await this.primary.query<{
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
