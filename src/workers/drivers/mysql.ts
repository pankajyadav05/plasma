import { ConnectionLostError } from '@shared/connection-loss';
import { mysqlAuxReadViolation, mysqlReadOnlyEscapeReason } from '@shared/mysql-readonly-sql';
import type {
  ConnectionConfig,
  IntrospectOpts,
  QueryResult,
  SchemaInfo,
  TxnState,
} from '@shared/protocol';
import {
  MAX_RESULT_BYTES,
  MAX_RESULT_BYTES_CEILING,
  MAX_RESULT_ROWS,
  appendBoundedRows,
  emptyBoundState,
} from '@shared/result-bounds';
import { translatePlaceholders } from '@shared/sql-dialect';
import { isTxnExemptSql, leadingKeyword, splitSqlStatements } from '@shared/sql-statements';
import { buildNodeTlsOptions } from '@shared/tls';
import { createConnection } from 'mysql2';
import type { Connection as CbConnection } from 'mysql2';
import { mysqlPlanToJson } from './explain-plan';
import { type MysqlRawSchema, buildMysqlSchema, mysqlIntrospectQueries } from './mysql-introspect';
import { type EditBatchConflict, runEditBatch } from './pg-txn';
import {
  type AiQueryOpts,
  CancelFailedError,
  type ExportBatch,
  type SqlEditUpdate,
  type SqlEngineDriver,
  type SqlQueryOpts,
  aiReadOpts,
} from './sql-engine';

/**
 * MySQL / MariaDB driver (mysql2). Two connections, like the Postgres driver:
 *
 *   primary — the user's statements and transactions
 *   aux     — introspection, counts / lookups, AI queries and `KILL QUERY`
 *             (so a refresh never queues behind a long statement, and a
 *             cancel never needs the connection it is cancelling)
 *
 * Read-only connections run `SET SESSION TRANSACTION READ ONLY` on both and
 * re-assert it before every user statement, so a statement that flips the
 * session back is undone before the next one runs.
 */

const READ_ONLY_SQL = 'SET SESSION TRANSACTION READ ONLY';
const SERVER_STATUS_IN_TRANS = 0x0001;

const TYPE_NAMES: Record<number, string> = {
  0: 'decimal',
  1: 'tinyint',
  2: 'smallint',
  3: 'int',
  4: 'float',
  5: 'double',
  7: 'timestamp',
  8: 'bigint',
  9: 'mediumint',
  10: 'date',
  11: 'time',
  12: 'datetime',
  13: 'year',
  15: 'varchar',
  16: 'bit',
  245: 'json',
  246: 'decimal',
  247: 'enum',
  248: 'set',
  253: 'varchar',
  254: 'char',
  255: 'geometry',
};

/** Readable type name for a result column from the wire type code. */
export function mysqlTypeName(columnType: number | undefined, charsetNr?: number): string {
  if (columnType === undefined) return '';
  if (columnType >= 249 && columnType <= 252) return charsetNr === 63 ? 'blob' : 'text';
  if ((columnType === 253 || columnType === 254) && charsetNr === 63) return 'binary';
  return TYPE_NAMES[columnType] ?? '';
}

/** A cell as the grid expects it: blobs as `\x…` text, dates and big numbers already strings. */
export function normalizeMysqlCell(value: unknown, columnType?: number): unknown {
  if (value instanceof Uint8Array) return `\\x${Buffer.from(value).toString('hex')}`;
  if (typeof value === 'bigint') return value.toString();
  // BIGINT arrives as text (so nothing past 2^53 is rounded); small ones are numbers.
  if (columnType === 8 && typeof value === 'string' && /^-?\d{1,15}$/.test(value))
    return Number(value);
  return value;
}

/** Bind values: booleans become 0/1, objects JSON text. */
export function toMysqlBinding(value: unknown): unknown {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === undefined) return null;
  if (value !== null && typeof value === 'object' && !(value instanceof Uint8Array)) {
    return JSON.stringify(value);
  }
  return value;
}

/** `MySQL 8.4.0` / `MariaDB 10.11.9` from `SELECT VERSION()`. */
export function mysqlServerVersion(version: string): string {
  const clean = version.replace(/^5\.5\.5-/, '');
  const num = clean.split('-')[0] ?? clean;
  return /mariadb/i.test(clean) ? `MariaDB ${num}` : `MySQL ${num}`;
}

const LOST_CODES = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
  'PROTOCOL_ENQUEUE_AFTER_QUIT',
]);
const INTERRUPTED_CODES = new Set([
  'ER_QUERY_INTERRUPTED',
  'ER_QUERY_TIMEOUT',
  'ER_STATEMENT_TIMEOUT',
]);
/** 3024: MySQL max_execution_time; 1969: MariaDB max_statement_time. */
const TIMEOUT_ERRNOS = new Set([3024, 1969]);

function errNo(err: unknown): number {
  return err && typeof err === 'object' && 'errno' in err
    ? Number((err as { errno: unknown }).errno)
    : 0;
}

function errCode(err: unknown): string {
  return err && typeof err === 'object' && 'code' in err
    ? String((err as { code: unknown }).code)
    : '';
}

type RawResult = Omit<QueryResult, 'durationMs'>;

export class MysqlDriver implements SqlEngineDriver {
  private primary: CbConnection | null = null;
  private aux: CbConnection | null = null;
  private txn: TxnState = 'none';
  private connectionGen = 0;
  private readOnly = false;
  private statementTimeoutMs = 0;
  private lostReason: string | null = null;
  private lostInTxn = false;
  private primaryTail: Promise<void> = Promise.resolve();
  private auxTail: Promise<void> = Promise.resolve();
  private killing = false;
  private running = false;

  isConnected(): boolean {
    return this.primary !== null && this.lostReason === null;
  }

  getTxnState(): TxnState {
    return this.txn;
  }

  setConnectionGen(gen: number): void {
    this.connectionGen = gen;
  }

  lostDuringTransaction(): boolean {
    return this.lostInTxn;
  }

  private open(config: ConnectionConfig): Promise<CbConnection> {
    const ssl = buildNodeTlsOptions(config);
    return new Promise((resolve, reject) => {
      const conn = createConnection({
        host: config.host,
        port: config.port,
        user: config.user || undefined,
        password: config.password || undefined,
        database: config.database || undefined,
        ssl,
        // Dates, times and big numbers stay exact text; the grid shows them as-is.
        dateStrings: true,
        supportBigNumbers: true,
        bigNumberStrings: true,
        multipleStatements: false,
        connectTimeout: 15_000,
      });
      conn.once('error', (err) => {
        if (!this.primary) reject(err);
      });
      conn.connect((err) => {
        if (err) reject(err);
        else resolve(conn);
      });
    });
  }

  private watch(conn: CbConnection): void {
    conn.on('error', (err) => {
      // A connection from a session that was already replaced (a reconnect) reports its
      // death late; it must not mark the new session as lost.
      if (conn !== this.primary && conn !== this.aux) return;
      if (LOST_CODES.has(errCode(err)) || (err as { fatal?: boolean }).fatal) {
        this.lostReason ??= err.message;
        this.lostInTxn ||= this.txn === 'active';
      }
    });
  }

  async connect(config: ConnectionConfig, statementTimeoutMs?: number): Promise<string> {
    // A second connect replaces the session: close the old one first, so its late
    // socket events cannot be read as the new session dying.
    await this.disconnect();
    this.readOnly = config.readOnly === true;
    this.statementTimeoutMs = statementTimeoutMs ?? 0;
    this.lostReason = null;
    this.lostInTxn = false;
    let primary: CbConnection | null = null;
    let aux: CbConnection | null = null;
    try {
      primary = await this.open(config);
      aux = await this.open(config);
      this.primary = primary;
      this.aux = aux;
      this.watch(primary);
      this.watch(aux);
      const res = await this.exec(primary, 'SELECT VERSION()', [], true);
      const version = String(res.rows[0]?.[0] ?? '');
      for (const c of [primary, aux]) {
        if (this.readOnly) await this.exec(c, READ_ONLY_SQL, [], true);
        await this.applyTimeout(c);
      }
      this.txn = 'none';
      return mysqlServerVersion(version);
    } catch (err) {
      this.primary = null;
      this.aux = null;
      for (const c of [primary, aux]) c?.destroy();
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    const conns = [this.primary, this.aux];
    this.primary = null;
    this.aux = null;
    this.txn = 'none';
    this.running = false;
    for (const c of conns) {
      if (!c) continue;
      try {
        c.destroy();
      } catch {
        // already gone
      }
    }
  }

  async setStatementTimeout(timeoutMs: number): Promise<void> {
    this.statementTimeoutMs = Math.max(0, timeoutMs);
    for (const c of [this.primary, this.aux]) if (c) await this.applyTimeout(c);
  }

  private async applyTimeout(conn: CbConnection): Promise<void> {
    const ms = this.statementTimeoutMs;
    try {
      // MySQL (reads only) …
      await this.exec(conn, `SET SESSION max_execution_time = ${Math.floor(ms)}`, [], true);
    } catch {
      try {
        // … MariaDB (seconds, all statements).
        await this.exec(conn, `SET SESSION max_statement_time = ${ms / 1000}`, [], true);
      } catch {
        // no server-side limit available
      }
    }
  }

  private requirePrimary(): CbConnection {
    if (this.lostReason) throw new ConnectionLostError(this.lostReason);
    if (!this.primary) throw new Error('not connected to a MySQL server');
    return this.primary;
  }

  private requireAux(): CbConnection {
    if (this.lostReason) throw new ConnectionLostError(this.lostReason);
    if (!this.aux) throw new Error('not connected to a MySQL server');
    return this.aux;
  }

  private async chain<T>(which: 'primaryTail' | 'auxTail', fn: () => Promise<T>): Promise<T> {
    const prev = this[which];
    let release!: () => void;
    this[which] = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private lossOr(err: unknown): unknown {
    if (LOST_CODES.has(errCode(err)) || this.lostReason) {
      if (this.lostReason === null && err instanceof Error) this.lostReason = err.message;
      return new ConnectionLostError(this.lostReason ?? String(err));
    }
    return err;
  }

  /**
   * Run one statement on `conn`. Rows stop at the display caps; hitting a cap
   * kills the statement server-side (`KILL QUERY`) instead of reading on.
   */
  private exec(
    conn: CbConnection,
    sql: string,
    params: unknown[],
    internal = false,
    opts?: SqlQueryOpts,
  ): Promise<RawResult> {
    // Plasma's own lookups (introspection) are not display results: no 10k cap.
    const maxRows = internal
      ? (opts?.maxRows ?? 500_000)
      : Math.min(opts?.maxRows ?? MAX_RESULT_ROWS, MAX_RESULT_ROWS);
    const maxBytes = Math.min(opts?.maxBytes ?? MAX_RESULT_BYTES, MAX_RESULT_BYTES_CEILING);
    return new Promise((resolveRaw, rejectRaw) => {
      // mysql2 reports a dead socket on the connection but does not always fail the
      // statement that was waiting on it, which left a query hanging forever.
      let settled = false;
      const onDrop = (err?: unknown) => {
        if (
          err !== undefined &&
          !LOST_CODES.has(errCode(err)) &&
          !(err as { fatal?: boolean }).fatal
        )
          return;
        reject(this.lossOr(err ?? new Error('connection lost: the server closed the connection')));
      };
      const unwatch = () => {
        conn.removeListener('error', onDrop);
        conn.removeListener('end', onDrop);
      };
      const resolve = (value: RawResult) => {
        if (settled) return;
        settled = true;
        unwatch();
        resolveRaw(value);
      };
      const reject = (reason: unknown) => {
        if (settled) return;
        settled = true;
        unwatch();
        rejectRaw(reason);
      };
      conn.on('error', onDrop);
      conn.on('end', onDrop);
      const state = emptyBoundState();
      let fields: Array<{ name: string; columnType?: number; characterSet?: number }> = [];
      let header: { affectedRows?: number; serverStatus?: number } | null = null;
      let capped = false;
      const q = conn.query({ sql, values: params.map(toMysqlBinding), rowsAsArray: true });
      q.on('fields', (f: typeof fields | undefined) => {
        fields = f ?? [];
      });
      q.on('result', (row: unknown) => {
        if (Array.isArray(row)) {
          if (capped) return;
          const cells = row.map((v, i) => normalizeMysqlCell(v, fields[i]?.columnType));
          if (appendBoundedRows(state, [cells], maxRows, maxBytes)) {
            capped = true;
            if (!internal) void this.killStatement(conn).catch(() => undefined);
          }
        } else if (row && typeof row === 'object') {
          header = row as typeof header;
        }
      });
      q.on('error', (err: unknown) => {
        // The one message every engine uses for a statement stopped by its timeout.
        if (!capped && !this.killing && TIMEOUT_ERRNOS.has(errNo(err))) {
          reject(new Error('canceling statement due to statement timeout'));
          return;
        }
        if (INTERRUPTED_CODES.has(errCode(err))) {
          if (capped) {
            finish();
            return;
          }
          if (this.killing) {
            reject(new Error('canceling statement due to user request'));
            return;
          }
        }
        reject(this.lossOr(err));
      });
      q.on('end', () => finish());
      const finish = () => {
        // OK packets (BEGIN, COMMIT, DML …) carry the server's transaction flag;
        // a plain SELECT leaves the state as it was.
        const status = header?.serverStatus;
        if (typeof status === 'number' && conn === this.primary) {
          this.txn = status & SERVER_STATUS_IN_TRANS ? 'active' : 'none';
        }
        const columns = fields.map((f) => ({
          name: f.name,
          dataTypeID: f.columnType ?? 0,
          dataTypeName: mysqlTypeName(f.columnType, f.characterSet),
        }));
        resolve({
          columns,
          rows: state.rows,
          rowCount: columns.length === 0 ? Number(header?.affectedRows ?? 0) : state.rows.length,
          command: leadingKeyword(sql).toUpperCase() || undefined,
          truncated: state.truncated,
        });
      };
    });
  }

  private async killStatement(conn: CbConnection): Promise<boolean> {
    const aux = this.aux;
    const id = (conn as unknown as { threadId?: number }).threadId;
    if (!aux || !id || conn === aux)
      throw new CancelFailedError('no side connection to send KILL QUERY');
    this.killing = true;
    try {
      await this.exec(aux, `KILL QUERY ${Number(id)}`, [], true);
      return true;
    } catch (err) {
      throw new CancelFailedError(err instanceof Error ? err.message : String(err));
    } finally {
      // The interrupted statement's error arrives a moment later.
      setTimeout(() => {
        this.killing = false;
      }, 200);
    }
  }

  private async reassertReadOnly(conn: CbConnection): Promise<void> {
    if (this.readOnly) await this.exec(conn, READ_ONLY_SQL, [], true);
  }

  /**
   * Before every user statement of a read-only connection: refuse text that
   * tries to leave read-only mode, and put the session default back (a
   * statement earlier in the same script may have changed it).
   */
  private async guardReadOnly(conn: CbConnection, sql: string): Promise<void> {
    if (!this.readOnly) return;
    const why = mysqlReadOnlyEscapeReason(sql);
    if (why) {
      throw new Error(
        `Read-only connection: ${why} is not allowed. Edit the connection to turn off read-only.`,
      );
    }
    await this.reassertReadOnly(conn);
  }

  private async runStatements(
    conn: CbConnection,
    sql: string,
    params: unknown[] | undefined,
    opts: SqlQueryOpts | undefined,
  ): Promise<RawResult> {
    const statements = splitSqlStatements(sql);
    if (statements.length === 0) return { columns: [], rows: [], rowCount: 0, command: '' };
    if (statements.length > 1 && params && params.length > 0) {
      throw new Error('bind parameters need a single statement');
    }
    if (opts?.autoBegin && this.txn === 'none' && !isTxnExemptSql(statements[0]!)) {
      // The transaction about to start must be a read-only one on a read-only connection;
      // each statement below re-asserts it again through guardReadOnly.
      await this.reassertReadOnly(conn);
      await this.exec(conn, 'START TRANSACTION', [], true);
    }
    let last: RawResult = { columns: [], rows: [], rowCount: 0 };
    for (const text of statements) {
      await this.guardReadOnly(conn, text);
      const t =
        statements.length === 1
          ? translatePlaceholders(text, params ?? [], { backslashEscapes: true })
          : { sql: text, params: [] };
      last = await this.exec(conn, t.sql, t.params, false, opts);
    }
    return last;
  }

  async query(sql: string, params?: unknown[], opts?: SqlQueryOpts): Promise<QueryResult> {
    const conn = this.requirePrimary();
    const start = Date.now();
    this.running = true;
    try {
      const res = await this.chain('primaryTail', () =>
        this.runStatements(conn, sql, params, opts),
      );
      return { ...res, durationMs: Date.now() - start, txnState: this.txn };
    } finally {
      this.running = false;
    }
  }

  /** Run one read on the aux connection inside a read-only transaction. */
  private async auxRead(
    sql: string,
    params: unknown[] | undefined,
    opts: SqlQueryOpts | undefined,
    timeoutMs?: number,
  ): Promise<QueryResult> {
    const conn = this.requireAux();
    const start = Date.now();
    // MariaDB runs DDL through a READ ONLY transaction (it commits first), so the
    // transaction alone is not the boundary: only reads get as far as the server.
    const violation = mysqlAuxReadViolation(sql);
    if (violation)
      throw new Error(`rejected: only read-only statements are allowed here (${violation})`);
    return this.chain('auxTail', async () => {
      const t = translatePlaceholders(sql, params ?? [], { backslashEscapes: true });
      await this.exec(conn, 'START TRANSACTION READ ONLY', [], true);
      try {
        if (timeoutMs) {
          await this.exec(
            conn,
            `SET SESSION max_execution_time = ${Math.floor(timeoutMs)}`,
            [],
            true,
          ).catch(() => undefined);
        }
        const res = await this.exec(conn, t.sql, t.params, true, opts);
        return { ...res, durationMs: Date.now() - start };
      } finally {
        await this.exec(conn, 'ROLLBACK', [], true).catch(() => undefined);
        if (timeoutMs) await this.applyTimeout(conn).catch(() => undefined);
      }
    });
  }

  async sidebandQuery(sql: string, params?: unknown[], opts?: SqlQueryOpts): Promise<QueryResult> {
    if (splitSqlStatements(sql).length !== 1) throw new Error('rejected: one statement at a time');
    return this.auxRead(sql, params, opts, opts?.timeoutMs);
  }

  async aiQuery(sql: string, params?: unknown[], opts?: AiQueryOpts): Promise<QueryResult> {
    if (splitSqlStatements(sql).length !== 1) {
      throw new Error('rejected: AI queries must be a single SQL statement');
    }
    return this.auxRead(sql, params, aiReadOpts(opts), 30_000);
  }

  async explain(sql: string, _analyze: boolean, params?: unknown[]): Promise<QueryResult> {
    const stripped = sql.trim().replace(/;\s*$/, '');
    if (splitSqlStatements(stripped).length !== 1)
      throw new Error('Explain takes exactly one statement.');
    const conn = this.requirePrimary();
    const start = Date.now();
    const res = await this.chain('primaryTail', async () => {
      await this.reassertReadOnly(conn);
      const t = translatePlaceholders(`EXPLAIN FORMAT=JSON ${stripped}`, params ?? [], {
        backslashEscapes: true,
      });
      return this.exec(conn, t.sql, t.params, true);
    });
    const plan = mysqlPlanToJson(String(res.rows[0]?.[0] ?? ''));
    return {
      columns: [{ name: 'EXPLAIN', dataTypeID: 0, dataTypeName: 'json' }],
      rows: [[JSON.stringify(plan)]],
      rowCount: 1,
      durationMs: Date.now() - start,
      txnState: this.txn,
    };
  }

  async cancelQuery(): Promise<boolean> {
    if (!this.primary || !this.running) return false;
    return this.killStatement(this.primary);
  }

  async cancelAux(): Promise<boolean> {
    return false;
  }

  private async control(sql: string): Promise<TxnState> {
    const conn = this.requirePrimary();
    await this.chain('primaryTail', async () => {
      await this.exec(conn, sql, [], true);
    });
    return this.txn;
  }

  beginTransaction(): Promise<TxnState> {
    return this.control('START TRANSACTION');
  }

  commitTransaction(): Promise<TxnState> {
    return this.control('COMMIT');
  }

  rollbackTransaction(): Promise<TxnState> {
    return this.control('ROLLBACK');
  }

  /**
   * Apply a grid edit batch atomically. Every statement must touch exactly one
   * row; a user transaction gets a SAVEPOINT and is never committed here.
   */
  async commitEditBatch(
    expectedGen: number,
    updates: SqlEditUpdate[],
  ): Promise<{ state: TxnState; applied: number; conflicts: EditBatchConflict[] }> {
    const conn = this.requirePrimary();
    if (expectedGen !== this.connectionGen) {
      throw new Error(
        `connection generation mismatch: edit batch is for generation ${expectedGen}, current is ${this.connectionGen}`,
      );
    }
    const client = {
      query: async (cfg: string | { text: string; values?: unknown[] }) => {
        const text = typeof cfg === 'string' ? cfg : cfg.text;
        const t =
          typeof cfg === 'string'
            ? { sql: text, params: [] as unknown[] }
            : translatePlaceholders(text, cfg.values ?? [], { backslashEscapes: true });
        if (/^(BEGIN)\b/i.test(t.sql)) {
          await this.exec(conn, 'START TRANSACTION', [], true);
          return { rowCount: 0 };
        }
        const res = await this.exec(conn, t.sql, t.params, true);
        return { rowCount: res.rowCount };
      },
    };
    const outcome = await this.chain('primaryTail', async () => {
      await this.reassertReadOnly(conn);
      return runEditBatch(client, this.txn === 'active' ? 'T' : 'I', updates);
    });
    return { state: this.txn, ...outcome };
  }

  /** Unbounded stream for file export: the server is read in batches, never buffered. */
  async *streamQueryForExport(
    sql: string,
    params?: unknown[],
  ): AsyncGenerator<ExportBatch, void, void> {
    const conn = this.requirePrimary();
    if (splitSqlStatements(sql).length !== 1)
      throw new Error('Export takes exactly one statement.');
    const t = translatePlaceholders(sql, params ?? [], { backslashEscapes: true });
    const release = await new Promise<() => void>((resolve) => {
      const prev = this.primaryTail;
      let done!: () => void;
      this.primaryTail = new Promise<void>((r) => {
        done = r;
      });
      void prev.then(() => resolve(done));
    });
    try {
      await this.reassertReadOnly(conn);
      const q = conn.query({ sql: t.sql, values: t.params.map(toMysqlBinding), rowsAsArray: true });
      let columns: QueryResult['columns'] = [];
      q.on('fields', (f: Array<{ name: string; columnType?: number; characterSet?: number }>) => {
        columns = f.map((x) => ({
          name: x.name,
          dataTypeID: x.columnType ?? 0,
          dataTypeName: mysqlTypeName(x.columnType, x.characterSet),
        }));
      });
      const stream = q.stream({ objectMode: true, highWaterMark: 500 });
      let batch: unknown[][] = [];
      let first = true;
      try {
        for await (const row of stream as AsyncIterable<unknown[]>) {
          batch.push(row.map((v) => normalizeMysqlCell(v)));
          if (batch.length >= 500) {
            yield { columns, rows: batch };
            first = false;
            batch = [];
          }
        }
      } catch (err) {
        throw this.lossOr(err);
      }
      if (batch.length > 0 || first) yield { columns, rows: batch };
    } finally {
      release();
    }
  }

  async introspect(opts?: IntrospectOpts): Promise<SchemaInfo> {
    const conn = this.requireAux();
    return this.chain('auxTail', async () => {
      const raw: MysqlRawSchema = {
        schemas: [],
        tables: [],
        columns: [],
        foreignKeys: [],
        indexes: [],
        triggers: [],
      };
      // Which schemas exist decides what the column-level queries may ask for.
      const schemaQuery = mysqlIntrospectQueries({ objects: true, columns: false }, [])[0]!;
      const schemaRows = await this.exec(conn, schemaQuery.sql, schemaQuery.params, true);
      const known = schemaRows.rows.map((r) => String(r[0]));
      for (const q of mysqlIntrospectQueries(opts, known)) {
        raw[q.key] = (await this.exec(conn, q.sql, q.params, true)).rows as unknown[][];
      }
      return buildMysqlSchema(raw, opts);
    });
  }
}
