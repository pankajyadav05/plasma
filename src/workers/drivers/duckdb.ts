import { statSync } from 'node:fs';
import { basename } from 'node:path';
import {
  DUCKDB_EXCEL_EXTENSION_MISSING,
  DUCKDB_PG_EXTENSION_MISSING,
  type DataFileKind,
  createViewSql,
  dataFileKind,
  dataFilePathProblem,
  dataFileStem,
  sheetViewStem,
  uniqueViewNames,
  viewNamesFor,
} from '@shared/data-files';
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
import { leadingKeyword, splitSqlStatements } from '@shared/sql-statements';
import {
  DUCKDB_INTROSPECT_SQL,
  type DuckdbRawSchema,
  type DuckdbViewSource,
  buildDuckdbSchema,
} from './duckdb-introspect';
import type { EditBatchConflict } from './pg-txn';
import type { ExportBatch, SqlEditUpdate, SqlEngineDriver, SqlQueryOpts } from './sql-engine';
import { XlsxError, xlsxSheetNames } from './xlsx-sheets';

import type {
  DuckDBConnection,
  DuckDBInstance,
  DuckDBPreparedStatement,
  DuckDBResult,
  DuckDBValue,
} from '@duckdb/node-api';

/**
 * DuckDB driver (@duckdb/node-api, N-API) — runs in the DB utilityProcess.
 *
 * Two kinds of session:
 *   - data files: an in-memory database where each CSV / TSV / Parquet / JSON
 *     file is a view named after the file (and optionally a read-only
 *     attachment of saved Postgres connections, to join files with live tables);
 *   - a .duckdb file, opened read-only.
 *
 * Everything that touches the outside (views, attachments) is set up first,
 * then the session is sandboxed: `allowed_paths` names exactly the opened
 * files, `enable_external_access` is off and the configuration is locked, so
 * a typed query cannot read another file, write one, load an extension or
 * lift the sandbox.
 *
 * One connection serves everything: sideband and AI queries run on it too,
 * but refuse anything that is not a read.
 */

// StatementType values from @duckdb/node-bindings (stable C API ids).
const ST = {
  SELECT: 1,
  EXPLAIN: 4,
  TRANSACTION: 10,
  COPY: 11,
  EXPORT: 16,
  PRAGMA: 17,
  CALL: 19,
  SET: 20,
  LOAD: 21,
  EXTENSION: 23,
  ATTACH: 25,
  DETACH: 26,
  COPY_DATABASE: 28,
  UPDATE_EXTENSIONS: 29,
} as const;

/** Statements that reach outside the session; refused for every connection. */
const FORBIDDEN_TYPES = new Set<number>([
  ST.COPY,
  ST.EXPORT,
  ST.ATTACH,
  ST.DETACH,
  ST.LOAD,
  ST.EXTENSION,
  ST.COPY_DATABASE,
  ST.UPDATE_EXTENSIONS,
  ST.SET,
]);
/** Statements allowed when a connection (or a sideband / AI query) must only read. */
const READ_TYPES = new Set<number>([ST.SELECT, ST.EXPLAIN, ST.TRANSACTION]);

// DuckDBTypeId values of the integer types the grid shows as numbers.
const INTEGER_TYPE_IDS = new Set<number>([2, 3, 4, 5, 6, 7, 8, 9]);

type Api = typeof import('@duckdb/node-api');
let apiPromise: Promise<Api> | null = null;
/** The native module is loaded on first use, so other engines never pay for it. */
function loadApi(): Promise<Api> {
  apiPromise ??= import('@duckdb/node-api').then((m) => {
    const mod = m as unknown as Api & { default?: Api };
    return mod.DuckDBInstance ? mod : (mod.default as Api);
  });
  return apiPromise;
}

export function singleQuotedSql(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/** A cell as the grid expects it: integers as numbers when safe, everything else as DuckDB's JSON form. */
export function normalizeDuckdbCell(value: unknown, typeId: number): unknown {
  if (INTEGER_TYPE_IDS.has(typeId) && typeof value === 'string' && /^-?\d{1,15}$/.test(value)) {
    return Number(value);
  }
  return value;
}

/** Bind values: renderer text stays text; objects become JSON text. */
export function toDuckdbBinding(value: unknown): DuckDBValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object' && !(value instanceof Uint8Array)) return JSON.stringify(value);
  return value as DuckDBValue;
}

function commandOf(sql: string): string {
  return leadingKeyword(sql).toUpperCase();
}

function friendlyError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (/INTERRUPT/i.test(message)) return new Error('canceling statement due to user request');
  const e = new Error(message.replace(/^(\w+ )?Error: /, '').trim() || message);
  return e;
}

type ColumnMetaT = QueryResult['columns'][number];

export class DuckdbDriver implements SqlEngineDriver {
  private instance: DuckDBInstance | null = null;
  private conn: DuckDBConnection | null = null;
  private cancelRequested = false;
  private timedOut = false;
  private running = false;
  private tail: Promise<void> = Promise.resolve();
  private statementTimeoutMs = 0;
  private readOnly = false;
  private mainCatalog = 'memory';
  private sources: DuckdbViewSource[] = [];
  /** Catalogs attached from saved Postgres connections: alias -> connection name. */
  private attached: Array<{ alias: string; label: string }> = [];

  isConnected(): boolean {
    return this.conn !== null;
  }

  getTxnState(): TxnState {
    return 'none';
  }

  /** Aliases of the attached Postgres catalogs (for the renderer's session banner). */
  attachments(): ReadonlyArray<{ alias: string; label: string }> {
    return this.attached;
  }

  setConnectionGen(_gen: number): void {
    // No edit batches run here, so there is no generation to check.
  }

  lostDuringTransaction(): boolean {
    return false;
  }

  async setStatementTimeout(timeoutMs: number): Promise<void> {
    this.statementTimeoutMs = Math.max(0, timeoutMs);
  }

  async connect(config: ConnectionConfig, statementTimeoutMs?: number): Promise<string> {
    const files = config.duckdb?.files ?? [];
    const database = config.database || ':memory:';
    const inMemory = database === ':memory:';
    if (!inMemory) {
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(database);
      } catch {
        throw new Error(`database file not found: ${database}`);
      }
      if (!stat.isFile()) throw new Error(`not a file: ${database}`);
    }
    for (const f of files) {
      const problem = dataFilePathProblem(f);
      if (problem) throw new Error(`${basename(f)}: ${problem}`);
      try {
        if (!statSync(f).isFile()) throw new Error('not a file');
      } catch {
        throw new Error(`data file not found: ${f}`);
      }
    }
    this.readOnly = config.readOnly === true;
    this.statementTimeoutMs = statementTimeoutMs ?? 0;

    const api = await loadApi();
    // A .duckdb file on its own is opened directly (read-only); next to data
    // files it is attached read-only to the in-memory session instead, since
    // the views need somewhere writable to live.
    const openDirectly = !inMemory && files.length === 0;
    const instance = await api.DuckDBInstance.create(openDirectly ? database : ':memory:', {
      ...(openDirectly ? { access_mode: 'READ_ONLY' } : {}),
      autoinstall_known_extensions: 'false',
    });
    let conn: DuckDBConnection | null = null;
    try {
      conn = await instance.connect();
      const allowed: string[] = [];
      this.sources = [];
      this.attached = [];

      // One view per file; an Excel workbook gives one view per visible sheet.
      const sources: Array<{ path: string; kind: DataFileKind; sheet?: string; stem: string }> = [];
      for (const path of files) {
        const kind = dataFileKind(path) as DataFileKind;
        if (kind !== 'xlsx') {
          sources.push({ path, kind, stem: dataFileStem(path) });
          continue;
        }
        let sheets: string[];
        try {
          sheets = xlsxSheetNames(path);
        } catch (err) {
          const why = err instanceof XlsxError ? err.message : friendlyError(err).message;
          throw new Error(`Could not read ${basename(path)}: ${why}`);
        }
        for (const sheet of sheets) {
          sources.push({
            path,
            kind,
            sheet,
            stem: sheets.length === 1 ? dataFileStem(path) : sheetViewStem(path, sheet),
          });
        }
      }
      const names = uniqueViewNames(sources.map((src) => src.stem));
      if (!inMemory && !openDirectly) {
        const [alias] = viewNamesFor([database], names);
        await conn.run(
          `ATTACH ${singleQuotedSql(database)} AS ${quoteIdent(alias as string)} (READ_ONLY)`,
        );
        allowed.push(database);
      } else if (openDirectly) {
        allowed.push(database);
      }

      if (sources.some((src) => src.kind === 'xlsx')) {
        try {
          await conn.run('LOAD excel');
        } catch (err) {
          // Not bundled: DuckDB downloads its signed extension on demand, but
          // only after the user has agreed to the download.
          if (!config.duckdb?.installExcelExtension) {
            throw new Error(
              `${DUCKDB_EXCEL_EXTENSION_MISSING}. It is a one-time download from extensions.duckdb.org (${friendlyError(err).message}).`,
            );
          }
          try {
            await conn.run('INSTALL excel');
            await conn.run('LOAD excel');
          } catch (installErr) {
            throw new Error(
              `Could not download DuckDB's Excel extension (${friendlyError(installErr).message}).`,
            );
          }
        }
      }

      const sizes = new Map<string, number | null>();
      const openedSheets = new Map<string, number>();
      const sheetErrors = new Map<string, string>();
      for (let i = 0; i < sources.length; i++) {
        const src = sources[i] as (typeof sources)[number];
        const view = names[i] as string;
        try {
          await conn.run(createViewSql(view, src.path, src.kind, src.sheet));
        } catch (err) {
          // A workbook can hold sheets read_xlsx cannot read (charts, empty
          // tabs): skip those, as long as one sheet of the workbook opens.
          if (src.sheet !== undefined) {
            if (!sheetErrors.has(src.path)) {
              sheetErrors.set(src.path, `${src.sheet}: ${friendlyError(err).message}`);
            }
            continue;
          }
          throw new Error(`Could not read ${basename(src.path)}: ${friendlyError(err).message}`);
        }
        if (src.sheet !== undefined)
          openedSheets.set(src.path, (openedSheets.get(src.path) ?? 0) + 1);
        if (!allowed.includes(src.path)) allowed.push(src.path);
        if (!sizes.has(src.path)) {
          let bytes: number | null = null;
          try {
            bytes = statSync(src.path).size;
          } catch {
            // gone since the check; the view still reports its own error on use
          }
          sizes.set(src.path, bytes);
        }
        this.sources.push({
          view,
          path: src.path,
          kind: src.kind,
          bytes: sizes.get(src.path) ?? null,
          ...(src.sheet !== undefined ? { sheet: src.sheet } : {}),
        });
      }
      for (const [path, why] of sheetErrors) {
        if (!openedSheets.get(path)) throw new Error(`Could not read ${basename(path)}: ${why}`);
      }

      const attach = config.duckdb?.attach ?? [];
      if (attach.length > 0) {
        try {
          await conn.run('LOAD postgres');
        } catch (err) {
          // Not bundled: DuckDB downloads its signed extension on demand, but
          // only after the user has agreed to the download.
          if (!config.duckdb?.installPostgresExtension) {
            throw new Error(
              `${DUCKDB_PG_EXTENSION_MISSING}. It is a one-time download from extensions.duckdb.org (${friendlyError(err).message}).`,
            );
          }
          try {
            await conn.run('INSTALL postgres');
            await conn.run('LOAD postgres');
          } catch (installErr) {
            throw new Error(
              `Could not download DuckDB's Postgres extension (${friendlyError(installErr).message}).`,
            );
          }
        }
        for (const a of attach) {
          const secret = `plasma_secret_${a.alias}`;
          const conninfo = [
            a.sslmode ? `sslmode=${a.sslmode}` : '',
            a.sslrootcert ? `sslrootcert=${libpqValue(a.sslrootcert)}` : '',
          ]
            .filter(Boolean)
            .join(' ');
          try {
            // The password lives in a temporary secret (redacted by DuckDB), not in SQL text or the catalog path.
            await conn.run(
              `CREATE TEMPORARY SECRET ${quoteIdent(secret)} (TYPE postgres, HOST ${singleQuotedSql(a.host)}, PORT ${a.port}, DATABASE ${singleQuotedSql(a.database)}, USER ${singleQuotedSql(a.user)}, PASSWORD ${singleQuotedSql(a.password)})`,
            );
            await conn.run(
              `ATTACH ${singleQuotedSql(conninfo)} AS ${quoteIdent(a.alias)} (TYPE postgres, SECRET ${quoteIdent(secret)}, READ_ONLY)`,
            );
          } catch (err) {
            throw new Error(
              `Could not attach Postgres as ${a.alias}: ${friendlyError(err).message.split(a.password).join('(hidden)')}`,
            );
          }
          this.attached.push({ alias: a.alias, label: a.alias });
        }
      }

      this.mainCatalog = String(
        (await conn.runAndReadAll(DUCKDB_INTROSPECT_SQL.mainCatalog)).getRows()[0]?.[0] ?? 'memory',
      );
      // Sandbox: only the opened files stay reachable; nothing can lift this.
      await conn.run(`SET allowed_paths = [${allowed.map(singleQuotedSql).join(', ')}]`);
      await conn.run('SET enable_external_access = false');
      await conn.run('SET lock_configuration = true');

      const version = String((await conn.runAndReadAll('SELECT version()')).getRows()[0]?.[0]);
      this.instance = instance;
      this.conn = conn;
      return version.replace(/^v/, '');
    } catch (err) {
      try {
        conn?.closeSync();
      } catch {
        // already closed
      }
      instance.closeSync();
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    const conn = this.conn;
    const instance = this.instance;
    this.conn = null;
    this.instance = null;
    this.cancelRequested = false;
    this.running = false;
    this.sources = [];
    this.attached = [];
    try {
      conn?.closeSync();
    } catch {
      // already closed
    }
    try {
      instance?.closeSync();
    } catch {
      // already closed
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

  private async locked<T>(fn: () => Promise<T> | T): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private requireConn(): DuckDBConnection {
    if (!this.conn) throw new Error('not connected to a DuckDB session');
    return this.conn;
  }

  /** Refuse what must not run: file writes / extensions always, writes when `readsOnly`. */
  private checkStatement(stmt: DuckDBPreparedStatement, readsOnly: boolean): void {
    const type = stmt.statementType as number;
    if (FORBIDDEN_TYPES.has(type)) {
      throw new Error(
        'rejected: this statement reaches outside the session (files, extensions, settings) and is not allowed',
      );
    }
    if ((readsOnly || this.readOnly) && !READ_TYPES.has(type)) {
      throw new Error(
        readsOnly
          ? 'rejected: only read-only statements are allowed here'
          : 'cannot execute this statement in a read-only session',
      );
    }
  }

  private checkCancelled(): void {
    if (this.cancelRequested) {
      this.cancelRequested = false;
      throw new Error('canceling statement due to user request');
    }
    if (this.timedOut) {
      this.timedOut = false;
      throw new Error('canceling statement due to statement timeout');
    }
  }

  private async prepare(
    conn: DuckDBConnection,
    text: string,
    params: unknown[] | undefined,
    readsOnly: boolean,
  ): Promise<DuckDBPreparedStatement> {
    const stmt = await conn.prepare(text);
    this.checkStatement(stmt, readsOnly);
    if (params && params.length > 0 && stmt.parameterCount > 0) {
      stmt.bind(params.slice(0, stmt.parameterCount).map(toDuckdbBinding));
    }
    return stmt;
  }

  private columnsOf(result: DuckDBResult): ColumnMetaT[] {
    return result.columnNames().map((name, i) => ({
      name,
      dataTypeID: 0,
      dataTypeName: result.columnType(i).toString().toLowerCase(),
    }));
  }

  private async executeLocked(
    sql: string,
    params: unknown[] | undefined,
    opts: SqlQueryOpts | undefined,
    readsOnly: boolean,
  ): Promise<Omit<QueryResult, 'durationMs'>> {
    const conn = this.requireConn();
    const statements = splitSqlStatements(sql);
    if (statements.length === 0) return { columns: [], rows: [], rowCount: 0, command: '' };
    if (statements.length > 1 && params && params.length > 0) {
      throw new Error('bind parameters need a single statement');
    }
    this.running = true;
    this.cancelRequested = false;
    this.timedOut = false;
    const timer =
      this.statementTimeoutMs > 0
        ? setTimeout(() => {
            this.timedOut = true;
            conn.interrupt();
          }, this.statementTimeoutMs)
        : null;
    try {
      let last: Omit<QueryResult, 'durationMs'> = { columns: [], rows: [], rowCount: 0 };
      for (const text of statements) {
        const stmt = await this.prepare(
          conn,
          text,
          statements.length === 1 ? params : undefined,
          readsOnly,
        );
        last = await this.runOne(stmt, text, opts);
      }
      return last;
    } catch (err) {
      if (this.timedOut) throw new Error('canceling statement due to statement timeout');
      throw friendlyError(err);
    } finally {
      if (timer) clearTimeout(timer);
      this.running = false;
      this.cancelRequested = false;
      this.timedOut = false;
    }
  }

  private async runOne(
    stmt: DuckDBPreparedStatement,
    text: string,
    opts: SqlQueryOpts | undefined,
  ): Promise<Omit<QueryResult, 'durationMs'>> {
    const result = await stmt.stream();
    if (result.columnCount === 0 || (result.returnType as number) !== 3) {
      return {
        columns: [],
        rows: [],
        rowCount: Number(result.rowsChanged),
        command: commandOf(text),
      };
    }
    const columns = this.columnsOf(result);
    const typeIds = columns.map((_, i) => result.columnTypeId(i) as number);
    const state = emptyBoundState();
    const maxRows = Math.min(opts?.maxRows ?? MAX_RESULT_ROWS, MAX_RESULT_ROWS);
    const maxBytes = Math.min(opts?.maxBytes ?? MAX_RESULT_BYTES, MAX_RESULT_BYTES_CEILING);
    const chunks = result.yieldRowsJson();
    try {
      outer: for await (const chunk of chunks) {
        for (const raw of chunk) {
          const row = (raw as unknown[]).map((v, i) =>
            normalizeDuckdbCell(v, typeIds[i] as number),
          );
          if (appendBoundedRows(state, [row], maxRows, maxBytes)) break outer;
        }
        this.checkCancelled();
      }
    } finally {
      await chunks.return?.(undefined);
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
    return { ...result, durationMs: Date.now() - start, txnState: 'none' };
  }

  async sidebandQuery(sql: string, params?: unknown[], opts?: SqlQueryOpts): Promise<QueryResult> {
    const start = Date.now();
    const result = await this.locked(() => this.executeLocked(sql, params, opts, true));
    return { ...result, durationMs: Date.now() - start };
  }

  async aiQuery(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (splitSqlStatements(sql).length !== 1) {
      throw new Error('rejected: AI queries must be a single SQL statement');
    }
    const start = Date.now();
    const result = await this.locked(() =>
      this.executeLocked(sql, params, { maxRows: 1000 }, true),
    );
    return { ...result, durationMs: Date.now() - start };
  }

  async explain(sql: string, analyze: boolean, params?: unknown[]): Promise<QueryResult> {
    const stripped = sql.trim().replace(/;\s*$/, '');
    if (splitSqlStatements(stripped).length !== 1) {
      throw new Error('Explain takes exactly one statement.');
    }
    const start = Date.now();
    const result = await this.locked(() =>
      this.executeLocked(
        `EXPLAIN ${analyze ? 'ANALYZE ' : ''}${stripped}`,
        params,
        undefined,
        true,
      ),
    );
    return { ...result, durationMs: Date.now() - start, txnState: 'none' };
  }

  async cancelQuery(): Promise<boolean> {
    if (!this.running || !this.conn) return false;
    this.cancelRequested = true;
    this.conn.interrupt();
    return true;
  }

  async cancelAux(): Promise<boolean> {
    return false;
  }

  // DuckDB sessions here have nothing to commit: views are read-only and the
  // in-memory scratch space is auto-committed.
  async beginTransaction(): Promise<TxnState> {
    return 'none';
  }

  async commitTransaction(): Promise<TxnState> {
    return 'none';
  }

  async rollbackTransaction(): Promise<TxnState> {
    return 'none';
  }

  async commitEditBatch(
    _expectedGen: number,
    _updates: SqlEditUpdate[],
  ): Promise<{ state: TxnState; applied: number; conflicts: EditBatchConflict[] }> {
    throw new Error('Rows cannot be edited in a DuckDB data-file session.');
  }

  async *streamQueryForExport(
    sql: string,
    params?: unknown[],
  ): AsyncGenerator<ExportBatch, void, void> {
    const conn = this.requireConn();
    const statements = splitSqlStatements(sql);
    if (statements.length !== 1) throw new Error('Export takes exactly one statement.');
    const release = await this.acquire();
    let result: DuckDBResult;
    try {
      const stmt = await this.prepare(conn, statements[0] as string, params, true);
      result = await stmt.stream();
      if (result.columnCount === 0) throw new Error('Export needs a statement that returns rows.');
    } catch (err) {
      release();
      throw friendlyError(err);
    }
    const columns = this.columnsOf(result);
    const typeIds = columns.map((_, i) => result.columnTypeId(i) as number);
    const chunks = result.yieldRowsJson();
    let first = true;
    this.running = true;
    this.cancelRequested = false;
    try {
      for await (const chunk of chunks) {
        yield {
          columns,
          rows: chunk.map((raw) =>
            (raw as unknown[]).map((v, i) => normalizeDuckdbCell(v, typeIds[i] as number)),
          ),
        };
        first = false;
        this.checkCancelled();
      }
      if (first) yield { columns, rows: [] };
    } catch (err) {
      throw friendlyError(err);
    } finally {
      await chunks.return?.(undefined);
      this.running = false;
      this.cancelRequested = false;
      release();
    }
  }

  async introspect(opts?: IntrospectOpts): Promise<SchemaInfo> {
    const conn = this.requireConn();
    return this.locked(async () => {
      const all = async (sql: string): Promise<unknown[][]> =>
        (await conn.runAndReadAll(sql)).getRowsJson() as unknown[][];
      const raw: DuckdbRawSchema = {
        mainCatalog: this.mainCatalog,
        tables: await all(DUCKDB_INTROSPECT_SQL.tables),
        columns: opts?.columns === false ? [] : await all(DUCKDB_INTROSPECT_SQL.columns),
        primaryKeys: opts?.columns === false ? [] : await all(DUCKDB_INTROSPECT_SQL.primaryKeys),
        indexes: opts?.columns === false ? [] : await all(DUCKDB_INTROSPECT_SQL.indexes),
      };
      return buildDuckdbSchema(raw, this.sources, opts);
    });
  }
}

/** A libpq conninfo value: quoted when it has spaces or quotes. */
function libpqValue(value: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : `'${value.replace(/[\\']/g, '\\$&')}'`;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
