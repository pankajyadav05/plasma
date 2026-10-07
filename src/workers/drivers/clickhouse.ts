import { randomUUID } from 'node:crypto';
import https from 'node:https';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { ClickHouseClient } from '@clickhouse/client';
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
import { CLICKHOUSE_DIALECT, translatePlaceholders } from '@shared/sql-dialect';
import { leadingKeyword, splitSqlStatements } from '@shared/sql-statements';
import { buildNodeTlsOptions } from '@shared/tls';
import {
  type ClickhouseRawSchema,
  buildClickhouseSchema,
  clickhouseIntrospectQueries,
  innerType,
} from './clickhouse-introspect';
import { clickhousePlanToJson } from './explain-plan';
import type { EditBatchConflict } from './pg-txn';
import type { ExportBatch, SqlEditUpdate, SqlEngineDriver, SqlQueryOpts } from './sql-engine';

/**
 * ClickHouse driver (@clickhouse/client over the HTTP(S) interface; pure JS).
 *
 *   user client — the user's statements; `readonly=1` when the connection is
 *                 read-only, so the server refuses every write and every
 *                 attempt to change the setting
 *   ro client   — lookups, counts and AI queries; always `readonly=1`, whatever
 *                 the connection allows
 *
 * ClickHouse has no transactions, so `begin` / `commit` / `rollback` are
 * no-ops. Writes run as asynchronous mutations (`ALTER … UPDATE`); the UI
 * warns before one and the grid never edits rows.
 *
 * Results are streamed as `JSONCompactEachRowWithNamesAndTypes` (the compact
 * JSON family behind `FORMAT JSON`): line 1 names, line 2 types, then rows.
 * Placeholders are inlined as escaped literals, since the HTTP interface
 * binds typed `{name:Type}` parameters only.
 */

const FORMAT = 'JSONCompactEachRowWithNamesAndTypes';
const READ_KEYWORDS = new Set([
  'select',
  'with',
  'show',
  'describe',
  'desc',
  'explain',
  'exists',
  'check',
  'values',
]);
/** Statements that the HTTP interface answers with rows in the default format. */
const USER_FORMAT_RE = /\bformat\s+[A-Za-z][A-Za-z0-9_]*\s*;?\s*$/i;
const KILL_TIMEOUT_MS = 5_000;

type Api = typeof import('@clickhouse/client');
let apiPromise: Promise<Api> | null = null;
/** The client is loaded on first use, so other engines never pay for it. */
function loadApi(): Promise<Api> {
  apiPromise ??= import('@clickhouse/client').then((m) => {
    const mod = m as unknown as Api & { default?: Api };
    return (mod as { createClient?: unknown }).createClient ? mod : (mod.default as Api);
  });
  return apiPromise;
}

const INT_TYPE_RE = /^U?Int(8|16|32|64|128|256)$/;
const BIG_INT_TYPE_RE = /^U?Int(64|128|256)$/;

/** A cell as the grid expects it: 64-bit and wider integers as numbers when safe, text otherwise. */
export function normalizeClickhouseCell(value: unknown, type: string): unknown {
  const inner = innerType(type);
  if (BIG_INT_TYPE_RE.test(inner) && typeof value === 'string' && /^-?\d{1,15}$/.test(value)) {
    return Number(value);
  }
  if (INT_TYPE_RE.test(inner) && typeof value === 'number' && !Number.isSafeInteger(value)) {
    return String(value);
  }
  return value;
}

/** Type name shown for a column: wrappers kept, since `Nullable(...)` matters to the user. */
export function clickhouseTypeName(type: string): string {
  return type;
}

/** True when `sql` is answered with rows (otherwise it is a command). */
export function clickhouseReturnsRows(sql: string): boolean {
  const first = leadingKeyword(sql.trim().replace(/^\(+/, '')).toLowerCase();
  return READ_KEYWORDS.has(first);
}

/** Split a response body into lines as they arrive. */
export async function* jsonLines(stream: AsyncIterable<Buffer | string>): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8');
  let rest = '';
  for await (const chunk of stream) {
    const text = rest + (typeof chunk === 'string' ? chunk : decoder.write(chunk));
    let start = 0;
    for (let nl = text.indexOf('\n', start); nl !== -1; nl = text.indexOf('\n', start)) {
      if (nl > start) yield text.slice(start, nl);
      start = nl + 1;
    }
    rest = text.slice(start);
  }
  rest += decoder.end();
  if (rest.trim()) yield rest;
}

/** `ClickHouse 24.8.4.13` style version from `SELECT version()`. */
export function clickhouseServerVersion(version: string): string {
  return `ClickHouse ${version.trim()}`;
}

interface ChError {
  code?: string | number;
  type?: string;
  message?: string;
}

function chCode(err: unknown): string {
  return err && typeof err === 'object' && 'code' in err ? String((err as ChError).code ?? '') : '';
}

/** Server message without the `Code: 62. DB::Exception:` prefix noise. */
export function friendlyClickhouseError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  const code = chCode(err);
  // 159 = TIMEOUT_EXCEEDED, 394 = QUERY_WAS_CANCELLED
  if (code === '159' || /^Timeout exceeded/i.test(message)) {
    return new Error('canceling statement due to statement timeout');
  }
  if (code === '394' || /QUERY_WAS_CANCELLED|Query was cancelled/i.test(message)) {
    return new Error('canceling statement due to user request');
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return new Error('canceling statement due to user request');
  }
  return err instanceof Error ? err : new Error(message);
}

type RawResult = Omit<QueryResult, 'durationMs'>;
type ColumnMetaT = QueryResult['columns'][number];

export class ClickhouseDriver implements SqlEngineDriver {
  private client: ClickHouseClient | null = null;
  private roClient: ClickHouseClient | null = null;
  private config: ConnectionConfig | null = null;
  private readOnly = false;
  private statementTimeoutMs = 0;
  private running: { id: string; abort: AbortController } | null = null;

  isConnected(): boolean {
    return this.client !== null;
  }

  getTxnState(): TxnState {
    return 'none';
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

  private async makeClient(config: ConnectionConfig, readonly: boolean): Promise<ClickHouseClient> {
    const api = await loadApi();
    const tls = buildNodeTlsOptions(config);
    const scheme = tls ? 'https' : 'http';
    return api.createClient({
      url: `${scheme}://${config.host}:${config.port}`,
      username: config.user || 'default',
      password: config.password ?? '',
      database: config.database || undefined,
      // Analytical queries run long; the statement timeout is enforced server-side.
      request_timeout: 3_600_000,
      application: 'Plasma',
      log: { level: api.ClickHouseLogLevel.OFF },
      ...(tls
        ? {
            http_agent: new https.Agent({
              keepAlive: true,
              rejectUnauthorized: tls.rejectUnauthorized,
              // Only the options that are set: Node rejects an explicit `undefined` identity check.
              ...(tls.ca ? { ca: tls.ca } : {}),
              ...(tls.cert ? { cert: tls.cert } : {}),
              ...(tls.key ? { key: tls.key } : {}),
              ...(tls.servername ? { servername: tls.servername } : {}),
              ...(tls.checkServerIdentity
                ? { checkServerIdentity: tls.checkServerIdentity as never }
                : {}),
            }),
          }
        : {}),
      clickhouse_settings: {
        // 64-bit integers and decimals as text, so nothing is rounded in JSON.
        output_format_json_quote_64bit_integers: 1,
        output_format_json_quote_decimals: 1,
        ...(readonly ? { readonly: '1' as const } : {}),
      },
    });
  }

  async connect(config: ConnectionConfig, statementTimeoutMs?: number): Promise<string> {
    this.readOnly = config.readOnly === true;
    this.statementTimeoutMs = statementTimeoutMs ?? 0;
    const client = await this.makeClient(config, this.readOnly);
    const roClient = this.readOnly ? client : await this.makeClient(config, true);
    try {
      const rs = await client.query({ query: 'SELECT version()', format: 'JSONCompactEachRow' });
      const rows = (await rs.json()) as unknown[][];
      this.client = client;
      this.roClient = roClient;
      this.config = config;
      return clickhouseServerVersion(String(rows[0]?.[0] ?? ''));
    } catch (err) {
      await client.close().catch(() => undefined);
      if (roClient !== client) await roClient.close().catch(() => undefined);
      throw friendlyClickhouseError(err);
    }
  }

  async disconnect(): Promise<void> {
    const { client, roClient } = this;
    this.client = null;
    this.roClient = null;
    this.running = null;
    await Promise.allSettled([
      client?.close(),
      roClient && roClient !== client ? roClient.close() : undefined,
    ]);
  }

  private requireClients(): { client: ClickHouseClient; roClient: ClickHouseClient } {
    if (!this.client || !this.roClient) throw new Error('not connected to ClickHouse');
    return { client: this.client, roClient: this.roClient };
  }

  private settings(): Record<string, string | number> {
    return this.statementTimeoutMs > 0
      ? { max_execution_time: Math.max(1, Math.ceil(this.statementTimeoutMs / 1000)) }
      : {};
  }

  /** Run one statement and read its answer; rows beyond the caps are not read. */
  private async runStatement(
    client: ClickHouseClient,
    text: string,
    opts: SqlQueryOpts | undefined,
    track: boolean,
  ): Promise<RawResult> {
    const id = randomUUID();
    const abort = new AbortController();
    if (track) this.running = { id, abort };
    const timeoutSec = opts?.timeoutMs ? Math.max(1, Math.ceil(opts.timeoutMs / 1000)) : undefined;
    try {
      const userFormat = USER_FORMAT_RE.test(text.trim());
      const res = await client.exec({
        query: text,
        query_id: id,
        abort_signal: abort.signal,
        clickhouse_settings: {
          ...this.settings(),
          ...(timeoutSec ? { max_execution_time: timeoutSec } : {}),
          ...(userFormat ? {} : { default_format: FORMAT }),
        },
      });
      const command = leadingKeyword(text).toUpperCase();
      const stream = res.stream as Readable;
      if (!userFormat && clickhouseReturnsRows(text)) {
        return await this.readRows(stream, command, opts);
      }
      if (userFormat) return await this.readRawText(stream, command, opts);
      // A command: the body is empty; the summary header says what was written.
      for await (const _ of stream) {
        // drain
      }
      const summary = res.summary as { written_rows?: string } | undefined;
      return { columns: [], rows: [], rowCount: Number(summary?.written_rows ?? 0), command };
    } catch (err) {
      if (abort.signal.aborted) throw new Error('canceling statement due to user request');
      throw friendlyClickhouseError(err);
    } finally {
      if (track && this.running?.id === id) this.running = null;
    }
  }

  private async readRows(
    stream: Readable,
    command: string,
    opts: SqlQueryOpts | undefined,
  ): Promise<RawResult> {
    const maxRows = Math.min(opts?.maxRows ?? MAX_RESULT_ROWS, MAX_RESULT_ROWS);
    const maxBytes = Math.min(opts?.maxBytes ?? MAX_RESULT_BYTES, MAX_RESULT_BYTES_CEILING);
    const state = emptyBoundState();
    let names: string[] | null = null;
    let types: string[] | null = null;
    let columns: ColumnMetaT[] = [];
    try {
      for await (const line of jsonLines(stream)) {
        if (names === null) {
          names = parseHeaderLine(line);
          continue;
        }
        if (types === null) {
          const header = parseHeaderLine(line);
          types = header;
          columns = names.map((name, i) => ({
            name,
            dataTypeID: 0,
            dataTypeName: clickhouseTypeName(header[i] ?? ''),
          }));
          continue;
        }
        const t = types;
        const row = parseRowLine(line).map((v, i) => normalizeClickhouseCell(v, t[i] ?? ''));
        if (appendBoundedRows(state, [row], maxRows, maxBytes)) break;
      }
    } finally {
      // Stops the download when the caps were reached first.
      stream.destroy();
    }
    return {
      columns,
      rows: state.rows,
      rowCount: state.rows.length,
      command: command || 'SELECT',
      truncated: state.truncated,
    };
  }

  /** A statement with its own `FORMAT` clause: the body is shown as text lines. */
  private async readRawText(
    stream: Readable,
    command: string,
    opts: SqlQueryOpts | undefined,
  ): Promise<RawResult> {
    const maxRows = Math.min(opts?.maxRows ?? MAX_RESULT_ROWS, MAX_RESULT_ROWS);
    const maxBytes = Math.min(opts?.maxBytes ?? MAX_RESULT_BYTES, MAX_RESULT_BYTES_CEILING);
    const state = emptyBoundState();
    try {
      for await (const line of jsonLines(stream)) {
        if (appendBoundedRows(state, [[line]], maxRows, maxBytes)) break;
      }
    } finally {
      stream.destroy();
    }
    return {
      columns: [{ name: 'result', dataTypeID: 0, dataTypeName: 'String' }],
      rows: state.rows,
      rowCount: state.rows.length,
      command: command || 'SELECT',
      truncated: state.truncated,
    };
  }

  private inline(sql: string, params: unknown[] | undefined): string {
    return translatePlaceholders(sql, params ?? [], {
      backslashEscapes: true,
      inline: (v) => CLICKHOUSE_DIALECT.literal(v),
    }).sql;
  }

  private async execute(
    client: ClickHouseClient,
    sql: string,
    params: unknown[] | undefined,
    opts: SqlQueryOpts | undefined,
    track: boolean,
  ): Promise<RawResult> {
    const statements = splitSqlStatements(sql);
    if (statements.length === 0) return { columns: [], rows: [], rowCount: 0, command: '' };
    if (statements.length > 1 && params && params.length > 0) {
      throw new Error('bind parameters need a single statement');
    }
    let last: RawResult = { columns: [], rows: [], rowCount: 0 };
    for (const text of statements) {
      const inlined = this.inline(text, statements.length === 1 ? params : undefined);
      last = await this.runStatement(client, inlined, opts, track);
    }
    return last;
  }

  async query(sql: string, params?: unknown[], opts?: SqlQueryOpts): Promise<QueryResult> {
    const { client } = this.requireClients();
    const start = Date.now();
    const result = await this.execute(client, sql, params, opts, true);
    return { ...result, durationMs: Date.now() - start, txnState: 'none' };
  }

  async sidebandQuery(sql: string, params?: unknown[], opts?: SqlQueryOpts): Promise<QueryResult> {
    const { roClient } = this.requireClients();
    const start = Date.now();
    const result = await this.execute(roClient, sql, params, opts, false);
    return { ...result, durationMs: Date.now() - start };
  }

  async aiQuery(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (splitSqlStatements(sql).length !== 1) {
      throw new Error('rejected: AI queries must be a single SQL statement');
    }
    const { roClient } = this.requireClients();
    const start = Date.now();
    const result = await this.execute(roClient, sql, params, { maxRows: 1000 }, false);
    return { ...result, durationMs: Date.now() - start };
  }

  async explain(sql: string, _analyze: boolean, params?: unknown[]): Promise<QueryResult> {
    const stripped = sql.trim().replace(/;\s*$/, '');
    if (splitSqlStatements(stripped).length !== 1) {
      throw new Error('Explain takes exactly one statement.');
    }
    const { roClient } = this.requireClients();
    const start = Date.now();
    const result = await this.execute(roClient, `EXPLAIN ${stripped}`, params, undefined, false);
    const lines = result.rows.map((r) => String(r[0] ?? ''));
    return {
      columns: [{ name: 'QUERY PLAN', dataTypeID: 0, dataTypeName: 'json' }],
      rows: [[JSON.stringify(clickhousePlanToJson(lines))]],
      rowCount: 1,
      durationMs: Date.now() - start,
      txnState: 'none',
    };
  }

  /** Abort the request and ask the server to kill the query (a closed socket alone does not). */
  async cancelQuery(): Promise<boolean> {
    const running = this.running;
    const config = this.config;
    if (!running || !config) return false;
    running.abort.abort();
    try {
      const killer = await this.makeClient({ ...config, readOnly: false }, false);
      try {
        await killer.command({
          query: `KILL QUERY WHERE query_id = ${CLICKHOUSE_DIALECT.quoteText(running.id)} ASYNC`,
          abort_signal: AbortSignal.timeout(KILL_TIMEOUT_MS),
        });
      } finally {
        await killer.close().catch(() => undefined);
      }
    } catch {
      // The request is already aborted; a failed KILL (no right to) is not fatal.
    }
    return true;
  }

  async cancelAux(): Promise<boolean> {
    return false;
  }

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
    throw new Error(
      'ClickHouse rows cannot be edited in the grid: mutations are asynchronous. Write an ALTER TABLE … UPDATE in the editor instead.',
    );
  }

  async *streamQueryForExport(
    sql: string,
    params?: unknown[],
  ): AsyncGenerator<ExportBatch, void, void> {
    const { roClient } = this.requireClients();
    const statements = splitSqlStatements(sql);
    if (statements.length !== 1) throw new Error('Export takes exactly one statement.');
    const text = this.inline(statements[0] as string, params);
    if (!clickhouseReturnsRows(text))
      throw new Error('Export needs a statement that returns rows.');
    const id = randomUUID();
    const abort = new AbortController();
    this.running = { id, abort };
    let stream: Readable | null = null;
    try {
      const res = await roClient.exec({
        query: text,
        query_id: id,
        abort_signal: abort.signal,
        clickhouse_settings: { default_format: FORMAT },
      });
      stream = res.stream as Readable;
      let names: string[] | null = null;
      let types: string[] | null = null;
      let columns: ColumnMetaT[] = [];
      let batch: unknown[][] = [];
      let first = true;
      for await (const line of jsonLines(stream)) {
        if (names === null) {
          names = parseHeaderLine(line);
          continue;
        }
        if (types === null) {
          types = parseHeaderLine(line);
          columns = names.map((name, i) => ({
            name,
            dataTypeID: 0,
            dataTypeName: clickhouseTypeName(types?.[i] ?? ''),
          }));
          continue;
        }
        const t = types;
        batch.push(parseRowLine(line).map((v, i) => normalizeClickhouseCell(v, t[i] ?? '')));
        if (batch.length >= 500) {
          yield { columns, rows: batch };
          first = false;
          batch = [];
        }
      }
      if (batch.length > 0 || first) yield { columns, rows: batch };
    } catch (err) {
      throw friendlyClickhouseError(err);
    } finally {
      stream?.destroy();
      if (this.running?.id === id) this.running = null;
    }
  }

  async introspect(opts?: IntrospectOpts): Promise<SchemaInfo> {
    const { roClient } = this.requireClients();
    const read = async (sql: string, params: unknown[]): Promise<unknown[][]> => {
      const rs = await roClient.query({
        query: this.inline(sql, params),
        format: 'JSONCompactEachRow',
      });
      return (await rs.json()) as unknown[][];
    };
    const raw: ClickhouseRawSchema = { schemas: [], tables: [], columns: [], indexes: [] };
    // The schema list scopes the per-column queries, so it is always read.
    const allSchemas = (
      await read('SELECT name FROM system.databases WHERE name NOT IN $1 ORDER BY name', [
        ['system', 'INFORMATION_SCHEMA', 'information_schema'],
      ])
    ).map((r) => String(r[0]));
    for (const q of clickhouseIntrospectQueries(opts, allSchemas)) {
      raw[q.key] = await read(q.sql, q.params);
    }
    return buildClickhouseSchema(raw, opts);
  }
}

function parseHeaderLine(line: string): string[] {
  const parsed: unknown = parseJsonLine(line);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

function parseRowLine(line: string): unknown[] {
  const parsed = parseJsonLine(line);
  return Array.isArray(parsed) ? parsed : [];
}

/** A line that is not JSON is a server error appended to the stream. */
function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(line.replace(/^__exception__\s*/, '').slice(0, 2000));
  }
}
