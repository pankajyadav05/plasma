import { statSync } from 'node:fs';
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
import Database from 'better-sqlite3';
import { type SqlitePlanRow, sqlitePlanToJson } from './explain-plan';
import { type EditBatchConflict, runEditBatch } from './pg-txn';
import {
  type AiQueryOpts,
  type ExportBatch,
  type SqlEditUpdate,
  type SqlEngineDriver,
  type SqlQueryOpts,
  aiReadOpts,
} from './sql-engine';
import { introspectSqlite } from './sqlite-introspect';

/**
 * SQLite driver (better-sqlite3, N-API) — runs in the DB utilityProcess, so
 * main and the renderer never block on it.
 *
 * better-sqlite3 is synchronous. Row iteration therefore yields to the event
 * loop every few hundred rows, which is what lets a `cancel` request (and any
 * other message) be handled while a big SELECT streams. A single step that
 * never produces a row (a pathological aggregate) cannot be interrupted —
 * SQLite exposes no interrupt through this binding.
 *
 * One connection serves everything: there is no second "sideband" session
 * (file-local lookups are cheap), but sideband and AI queries still refuse
 * anything that is not a read.
 */

const YIELD_EVERY_ROWS = 500;
const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

type ColumnMetaT = QueryResult['columns'][number];

/** Affinity-style readable name for a declared SQLite column type. */
export function sqliteTypeName(declared: string | null | undefined): string {
  const t = (declared ?? '').trim().toLowerCase();
  if (!t) return '';
  const base = t.replace(/\(.*\)/, '').trim();
  if (/^(bool|boolean)$/.test(base)) return 'boolean';
  if (/^(json|jsonb)$/.test(base)) return base;
  if (/^(datetime|timestamp)/.test(base)) return 'timestamp';
  if (base === 'date') return 'date';
  if (base === 'time') return 'time';
  if (/int/.test(base)) return /^(big|unsigned big)int$/.test(base) ? 'bigint' : 'integer';
  if (/(char|clob|text)/.test(base)) return 'text';
  if (/blob/.test(base)) return 'bytea';
  if (/(real|floa|doub)/.test(base)) return 'real';
  if (/(numeric|decimal)/.test(base)) return 'numeric';
  return base;
}

/** Type name from a value, for expression columns that have no declared type. */
export function sqliteValueTypeName(value: unknown): string {
  if (typeof value === 'bigint' || (typeof value === 'number' && Number.isInteger(value)))
    return 'integer';
  if (typeof value === 'number') return 'real';
  if (typeof value === 'string') return 'text';
  if (value instanceof Uint8Array) return 'bytea';
  return '';
}

/** A cell as the grid expects it: safe integers as numbers, huge ones and blobs as text. */
export function normalizeSqliteCell(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Uint8Array) return `\\x${Buffer.from(value).toString('hex')}`;
  return value;
}

/** Bind values: renderer text stays text (SQLite applies column affinity); booleans become 0/1. */
export function toSqliteBinding(value: unknown): unknown {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === undefined) return null;
  if (value !== null && typeof value === 'object' && !(value instanceof Uint8Array)) {
    return JSON.stringify(value);
  }
  return value;
}

function commandOf(sql: string): string {
  return leadingKeyword(sql).toUpperCase();
}

type Statement = Database.Statement<unknown[], unknown[]>;

export class SqliteDriver implements SqlEngineDriver {
  private db: Database.Database | null = null;
  private connectionGen = 0;
  private cancelRequested = false;
  private running = false;
  /** Tail of the statement queue: one connection runs one statement at a time. */
  private tail: Promise<void> = Promise.resolve();
  private statementTimeoutMs = 0;
  private readOnly = false;
  private filePath = '';

  isConnected(): boolean {
    return this.db?.open === true;
  }

  getTxnState(): TxnState {
    return this.db?.inTransaction ? 'active' : 'none';
  }

  setConnectionGen(gen: number): void {
    this.connectionGen = gen;
  }

  lostDuringTransaction(): boolean {
    return false;
  }

  async setStatementTimeout(timeoutMs: number): Promise<void> {
    this.statementTimeoutMs = Math.max(0, timeoutMs);
  }

  async connect(config: ConnectionConfig, statementTimeoutMs?: number): Promise<string> {
    const path = config.database;
    if (!path) throw new Error('SQLite connection has no database file');
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path);
    } catch {
      throw new Error(`database file not found: ${path}`);
    }
    if (!stat.isFile()) throw new Error(`not a file: ${path}`);
    this.readOnly = config.readOnly === true;
    this.statementTimeoutMs = statementTimeoutMs ?? 0;
    const db = new Database(path, { readonly: this.readOnly, fileMustExist: true });
    try {
      db.pragma('foreign_keys = ON');
      db.pragma('busy_timeout = 5000');
      // Fails here, not later, when the file is not a database.
      const row = db.prepare('select sqlite_version() as v').get() as { v: string };
      if (this.readOnly) db.pragma('query_only = ON');
      this.db = db;
      this.filePath = path;
      return row.v;
    } catch (err) {
      db.close();
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    const db = this.db;
    this.db = null;
    this.cancelRequested = false;
    this.running = false;
    if (db?.open) {
      try {
        db.close();
      } catch {
        // already closed
      }
    }
  }

  private acquire(): Promise<() => void> {
    let release!: () => void;
    const prev = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return prev.then(() => release);
  }

  /** Statements share one synchronous connection, so they take turns. */
  private async locked<T>(fn: () => Promise<T> | T): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private requireDb(): Database.Database {
    if (!this.db?.open) throw new Error('not connected to a SQLite database');
    return this.db;
  }

  /** Re-assert read-only before every user statement (SC-02 equivalent). */
  private assertReadOnly(db: Database.Database): void {
    if (!this.readOnly) return;
    db.pragma('query_only = ON');
  }

  private prepare(db: Database.Database, sql: string, params: unknown[] | undefined) {
    const { sql: text, params: ordered } = translatePlaceholders(sql, params ?? []);
    const stmt = db.prepare(text) as Statement;
    stmt.safeIntegers(true);
    return { stmt, bind: ordered.map(toSqliteBinding) };
  }

  private checkCancelled(): void {
    if (this.cancelRequested) {
      this.cancelRequested = false;
      throw new Error('canceling statement due to user request');
    }
  }

  /**
   * Run every statement of `sql`; the last one's result is returned. With
   * `readsOnly`, any statement that could write is refused up front.
   */
  private async executeLocked(
    sql: string,
    params: unknown[] | undefined,
    opts: SqlQueryOpts | undefined,
    readsOnly: boolean,
  ): Promise<Omit<QueryResult, 'durationMs'>> {
    const db = this.requireDb();
    const statements = splitSqlStatements(sql);
    if (statements.length === 0) {
      return { columns: [], rows: [], rowCount: 0, command: '' };
    }
    if (statements.length > 1 && params && params.length > 0) {
      throw new Error('bind parameters need a single statement');
    }
    this.running = true;
    this.cancelRequested = false;
    const startedAt = Date.now();
    try {
      this.assertReadOnly(db);
      if (opts?.autoBegin && !db.inTransaction && !isTxnExemptSql(statements[0]!)) {
        db.exec('BEGIN');
      }
      let last: Omit<QueryResult, 'durationMs'> = { columns: [], rows: [], rowCount: 0 };
      for (const text of statements) {
        const { stmt, bind } = this.prepare(db, text, statements.length === 1 ? params : undefined);
        if (readsOnly && !stmt.readonly) {
          throw new Error('rejected: only read-only statements are allowed here');
        }
        last = await this.runOne(stmt, bind, text, opts, startedAt);
      }
      return last;
    } finally {
      this.running = false;
      this.cancelRequested = false;
    }
  }

  private async runOne(
    stmt: Statement,
    bind: unknown[],
    text: string,
    opts: SqlQueryOpts | undefined,
    startedAt: number,
  ): Promise<Omit<QueryResult, 'durationMs'>> {
    if (!stmt.reader) {
      const info = stmt.run(...bind);
      return {
        columns: [],
        rows: [],
        rowCount: Number(info.changes),
        command: commandOf(text),
      };
    }
    const meta = stmt.columns();
    const columns: ColumnMetaT[] = meta.map((c) => ({
      name: c.name,
      dataTypeID: 0,
      dataTypeName: sqliteTypeName(c.type),
    }));
    const state = emptyBoundState();
    const maxRows = Math.min(opts?.maxRows ?? MAX_RESULT_ROWS, opts?.rowCeiling ?? MAX_RESULT_ROWS);
    const maxBytes = Math.min(opts?.maxBytes ?? MAX_RESULT_BYTES, MAX_RESULT_BYTES_CEILING);
    const iterator = stmt.raw(true).iterate(...bind) as IterableIterator<unknown[]>;
    let sinceYield = 0;
    try {
      for (const raw of iterator) {
        const row = raw.map(normalizeSqliteCell);
        if (appendBoundedRows(state, [row], maxRows, maxBytes)) break;
        if (++sinceYield >= YIELD_EVERY_ROWS) {
          sinceYield = 0;
          await yieldToLoop();
          this.checkCancelled();
          if (this.statementTimeoutMs > 0 && Date.now() - startedAt > this.statementTimeoutMs) {
            throw new Error('canceling statement due to statement timeout');
          }
        }
      }
    } finally {
      // Releases the statement even when we stop early (cap / cancel / error).
      iterator.return?.();
    }
    // Expression columns have no declared type; infer it from the first row.
    for (let i = 0; i < columns.length; i++) {
      if (!columns[i]!.dataTypeName && state.rows[0]) {
        columns[i]!.dataTypeName = sqliteValueTypeName(state.rows[0][i]);
      }
    }
    return {
      columns,
      rows: state.rows,
      rowCount: state.rows.length,
      command: commandOf(text) || 'SELECT',
      truncated: state.truncated,
    };
  }

  async query(sql: string, params?: unknown[], opts?: SqlQueryOpts): Promise<QueryResult> {
    const start = Date.now();
    const result = await this.locked(() => this.executeLocked(sql, params, opts, false));
    return { ...result, durationMs: Date.now() - start, txnState: this.getTxnState() };
  }

  async sidebandQuery(sql: string, params?: unknown[], opts?: SqlQueryOpts): Promise<QueryResult> {
    const start = Date.now();
    const result = await this.locked(() => this.executeLocked(sql, params, opts, true));
    return { ...result, durationMs: Date.now() - start };
  }

  async aiQuery(sql: string, params?: unknown[], opts?: AiQueryOpts): Promise<QueryResult> {
    if (splitSqlStatements(sql).length !== 1) {
      throw new Error('rejected: AI queries must be a single SQL statement');
    }
    const db = this.requireDb();
    const start = Date.now();
    return this.locked(async () => {
      // query_only is on for the duration, whatever the statement tries.
      const before = db.pragma('query_only', { simple: true });
      db.pragma('query_only = ON');
      try {
        const result = await this.executeLocked(sql, params, aiReadOpts(opts), true);
        return { ...result, durationMs: Date.now() - start };
      } finally {
        db.pragma(`query_only = ${before ? 'ON' : 'OFF'}`);
      }
    });
  }

  async explain(sql: string, _analyze: boolean, params?: unknown[]): Promise<QueryResult> {
    const stripped = sql.trim().replace(/;\s*$/, '');
    if (splitSqlStatements(stripped).length !== 1) {
      throw new Error('Explain takes exactly one statement.');
    }
    const start = Date.now();
    const result = await this.locked(() =>
      this.executeLocked(`EXPLAIN QUERY PLAN ${stripped}`, params, undefined, false),
    );
    const rows: SqlitePlanRow[] = result.rows.map((r) => ({
      id: Number(r[0]),
      parent: Number(r[1]),
      detail: String(r[3] ?? ''),
    }));
    return {
      columns: [{ name: 'QUERY PLAN', dataTypeID: 0, dataTypeName: 'json' }],
      rows: [[JSON.stringify(sqlitePlanToJson(rows))]],
      rowCount: 1,
      durationMs: Date.now() - start,
      txnState: this.getTxnState(),
    };
  }

  async cancelQuery(): Promise<boolean> {
    if (!this.running) return false;
    this.cancelRequested = true;
    return true;
  }

  async cancelAux(): Promise<boolean> {
    return false;
  }

  async beginTransaction(): Promise<TxnState> {
    const db = this.requireDb();
    await this.locked(() => {
      if (!db.inTransaction) db.exec('BEGIN');
    });
    return this.getTxnState();
  }

  async commitTransaction(): Promise<TxnState> {
    const db = this.requireDb();
    await this.locked(() => {
      if (db.inTransaction) db.exec('COMMIT');
    });
    return this.getTxnState();
  }

  async rollbackTransaction(): Promise<TxnState> {
    const db = this.requireDb();
    await this.locked(() => {
      if (db.inTransaction) db.exec('ROLLBACK');
    });
    return this.getTxnState();
  }

  /**
   * Apply a grid edit batch atomically. Same contract as Postgres: each
   * statement must touch exactly one row, a user transaction gets a
   * SAVEPOINT, and any failure rolls the whole batch back.
   */
  async commitEditBatch(
    expectedGen: number,
    updates: SqlEditUpdate[],
  ): Promise<{ state: TxnState; applied: number; conflicts: EditBatchConflict[] }> {
    const db = this.requireDb();
    if (expectedGen !== this.connectionGen) {
      throw new Error(
        `connection generation mismatch: edit batch is for generation ${expectedGen}, current is ${this.connectionGen}`,
      );
    }
    this.assertReadOnly(db);
    const client = {
      query: async (cfg: string | { text: string; values?: unknown[] }) => {
        const text = typeof cfg === 'string' ? cfg : cfg.text;
        const values = typeof cfg === 'string' ? [] : (cfg.values ?? []);
        if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(text)) {
          db.exec(text);
          return { rowCount: 0 };
        }
        const { stmt, bind } = this.prepare(db, text, values);
        const info = stmt.run(...bind);
        return { rowCount: Number(info.changes) };
      },
    };
    const outcome = await this.locked(() =>
      runEditBatch(client, db.inTransaction ? 'T' : 'I', updates),
    );
    return { state: this.getTxnState(), ...outcome };
  }

  /** Unbounded stream for file export: batches of rows, no display caps. */
  async *streamQueryForExport(
    sql: string,
    params?: unknown[],
  ): AsyncGenerator<ExportBatch, void, void> {
    const db = this.requireDb();
    const statements = splitSqlStatements(sql);
    if (statements.length !== 1) throw new Error('Export takes exactly one statement.');
    const release = await this.acquire();
    let stmt: Statement;
    let bind: unknown[];
    try {
      ({ stmt, bind } = this.prepare(db, statements[0]!, params));
      if (!stmt.reader) throw new Error('Export needs a statement that returns rows.');
    } catch (err) {
      release();
      throw err;
    }
    const columns: ColumnMetaT[] = stmt.columns().map((c) => ({
      name: c.name,
      dataTypeID: 0,
      dataTypeName: sqliteTypeName(c.type),
    }));
    const iterator = stmt.raw(true).iterate(...bind) as IterableIterator<unknown[]>;
    let batch: unknown[][] = [];
    let first = true;
    this.running = true;
    this.cancelRequested = false;
    try {
      for (const raw of iterator) {
        batch.push(raw.map(normalizeSqliteCell));
        if (batch.length >= 500) {
          yield { columns, rows: batch };
          first = false;
          batch = [];
          await yieldToLoop();
          this.checkCancelled();
        }
      }
      // An empty result still exports its header.
      if (batch.length > 0 || first) yield { columns, rows: batch };
    } finally {
      iterator.return?.();
      this.running = false;
      this.cancelRequested = false;
      release();
    }
  }

  async introspect(opts?: IntrospectOpts): Promise<SchemaInfo> {
    const db = this.requireDb();
    return this.locked(() => introspectSqlite(db, opts));
  }

  /**
   * Copy the open database to `destination` with SQLite's online backup API
   * (a consistent snapshot, safe while the app has the file open).
   */
  async backupTo(destination: string): Promise<{ bytes: number }> {
    const db = this.requireDb();
    if (destination === this.filePath)
      throw new Error('Choose a different file than the database itself.');
    await db.backup(destination);
    return { bytes: statSync(destination).size };
  }
}
