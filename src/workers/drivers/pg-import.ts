import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import {
  type Cell,
  CsvParser,
  JsonArrayStream,
  LineSplitter,
  parseJsonObject,
} from '@shared/import-parse';
import { buildBatchInsert, mapCsvRow, mapJsonRow, rowsPerBatch } from '@shared/import-plan';
import type {
  DdlApplyRequest,
  DdlApplyResult,
  ImportJobSpec,
  ImportResult,
} from '@shared/protocol';
import { splitSqlStatementRanges, unsupportedStatementReason } from '@shared/sql-split';
import { leadingKeyword } from '@shared/sql-statements';
import type { TxnStatus } from './pg-txn';

/**
 * Worker-side execution for the structure editor's Apply and for
 * "Import into a table". Both take a minimal `client` so tests can run
 * them against a real `pg.Client` or a fake.
 */
export interface ImportClient {
  query(
    config: string | { text: string; values?: unknown[] },
  ): Promise<{ rowCount: number | null }>;
}

function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as Error & { detail?: string; hint?: string };
  return [e.message, e.detail].filter(Boolean).join(' — ');
}

const OPEN_TXN =
  'A transaction is open on this connection. Commit or roll it back first, then run this again.';
const ABORTED_TXN =
  'The current transaction has failed (aborted). Roll it back before running this.';

// ─── structure DDL ───────────────────────────────────────────────────

/**
 * Run the statements of a structure change. The transactional ones are
 * atomic (BEGIN … COMMIT, or a SAVEPOINT inside the user's open
 * transaction). CONCURRENTLY statements cannot run in a transaction block
 * and go one at a time afterwards — refused while the user's own
 * transaction is open.
 */
export async function applyDdl(
  client: ImportClient,
  status: TxnStatus,
  req: Pick<DdlApplyRequest, 'transactional' | 'concurrent'>,
): Promise<DdlApplyResult> {
  if (status === 'E')
    return { executed: 0, error: { message: ABORTED_TXN, statement: '', index: 0 } };
  const nested = status === 'T';
  if (nested && req.concurrent.length > 0) {
    return {
      executed: 0,
      error: {
        message: `CONCURRENTLY cannot run inside a transaction block. ${OPEN_TXN}`,
        statement: req.concurrent[0] ?? '',
        index: req.transactional.length,
      },
    };
  }
  let executed = 0;
  if (req.transactional.length > 0) {
    await client.query(nested ? 'SAVEPOINT plasma_structure' : 'BEGIN');
    let i = 0;
    try {
      for (; i < req.transactional.length; i++) {
        await client.query(req.transactional[i] as string);
      }
      await client.query(nested ? 'RELEASE SAVEPOINT plasma_structure' : 'COMMIT');
      executed = req.transactional.length;
    } catch (err) {
      try {
        if (nested) {
          await client.query('ROLLBACK TO SAVEPOINT plasma_structure');
          await client.query('RELEASE SAVEPOINT plasma_structure');
        } else {
          await client.query('ROLLBACK');
        }
      } catch {
        // connection gone: the original error is the one that matters
      }
      return {
        executed: 0,
        error: {
          message: `${errorText(err)}. Nothing was changed.`,
          statement: req.transactional[i] ?? '',
          index: i,
        },
      };
    }
  }
  for (let j = 0; j < req.concurrent.length; j++) {
    try {
      await client.query(req.concurrent[j] as string);
      executed++;
    } catch (err) {
      return {
        executed,
        error: {
          message: errorText(err),
          statement: req.concurrent[j] as string,
          index: req.transactional.length + j,
        },
      };
    }
  }
  return { executed };
}

// ─── import ──────────────────────────────────────────────────────────

class RowError extends Error {
  constructor(
    message: string,
    readonly row: number | undefined,
    readonly sample: string | undefined,
  ) {
    super(message);
  }
}

class CancelledError extends Error {}

const SET_STATEMENT =
  /^((?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*)set\s+(?!local\b|transaction\b|session\s+characteristics\b)(?:session\s+)?/i;
const SET_CONFIG_SESSION =
  /(\bset_config\s*\(\s*'(?:[^']|'')*'\s*,\s*(?:'(?:[^']|'')*'|[^,()]+)\s*,\s*)false(\s*\))/gi;

/**
 * P1-9: pg_dump headers set session state (`SET search_path`,
 * `statement_timeout`, `set_config('search_path', '', false)`). The import
 * runs in one transaction, but a plain SET survives COMMIT and would leave
 * the user's live session without its search_path / timeout. Make them
 * transaction-local: they apply for the rest of the import and vanish at
 * COMMIT / ROLLBACK, exactly like the user's own settings were before.
 */
export function localizeSessionSettings(statement: string): string {
  if (/\bset_config\b/i.test(statement)) {
    return statement.replace(SET_CONFIG_SESSION, '$1true$2');
  }
  return statement.replace(SET_STATEMENT, '$1SET LOCAL ');
}

export interface ImportHooks {
  isCancelled(): boolean;
  onProgress(p: {
    rowsRead: number;
    rowsImported: number;
    bytesRead: number;
    totalBytes: number;
  }): void;
}

const CHUNK_BYTES = 1024 * 1024;
const PROGRESS_MS = 200;

function sampleOf(cells: readonly Cell[]): string {
  const text = cells.map((c) => (c === null ? 'NULL' : c)).join(' | ');
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

/** UTF-8 byte-order mark: Excel, PowerShell and Plasma's own CSV export write one (P1-8). */
const BOM = '\uFEFF';

/** Drop a leading BOM so it never lands in the first header / value / statement. */
export async function* withoutBom(chunks: AsyncIterable<string>): AsyncGenerator<string> {
  let first = true;
  for await (const chunk of chunks) {
    if (first) {
      first = false;
      yield chunk.startsWith(BOM) ? chunk.slice(1) : chunk;
    } else {
      yield chunk;
    }
  }
}

/** Yield the file as text chunks; `bytes()` reports how far the read got. */
function readChunks(filePath: string) {
  const stream = createReadStream(filePath, { encoding: 'utf8', highWaterMark: CHUNK_BYTES });
  return {
    chunks: withoutBom(stream as AsyncIterable<string>),
    bytes: () => stream.bytesRead,
    destroy: () => stream.destroy(),
  };
}

export async function runImport(
  client: ImportClient,
  status: TxnStatus,
  job: ImportJobSpec,
  hooks: ImportHooks,
): Promise<ImportResult> {
  const base = { jobId: job.jobId, rowsImported: 0, rowsRead: 0 };
  if (status === 'T') return { ...base, ok: false, error: { message: OPEN_TXN } };
  if (status === 'E') return { ...base, ok: false, error: { message: ABORTED_TXN } };
  let totalBytes: number;
  try {
    totalBytes = (await stat(job.filePath)).size;
  } catch (err) {
    return { ...base, ok: false, error: { message: `Cannot read the file: ${errorText(err)}` } };
  }

  let rowsRead = 0;
  let rowsImported = 0;
  let statements: number | undefined;
  let lastProgress = 0;
  const src = readChunks(job.filePath);
  const progress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastProgress < PROGRESS_MS) return;
    lastProgress = now;
    hooks.onProgress({
      rowsRead,
      rowsImported,
      bytesRead: Math.min(src.bytes(), totalBytes),
      totalBytes,
    });
  };
  const checkCancel = () => {
    if (hooks.isCancelled()) throw new CancelledError();
  };

  const targets = job.columns.map((c) => c.target);
  const batchSize = rowsPerBatch(targets.length, job.batchRows);
  let pending: Cell[][] = [];
  /** File line (CSV) or record number (JSON) of each pending row, for error messages. */
  let pendingLines: number[] = [];

  const insertBatch = async (rows: Cell[][], lines: number[]): Promise<void> => {
    await client.query('SAVEPOINT plasma_import_batch');
    try {
      await client.query({
        text: buildBatchInsert(job.schema, job.table, targets, rows.length),
        values: rows.flat(),
      });
      await client.query('RELEASE SAVEPOINT plasma_import_batch');
    } catch (batchErr) {
      await client.query('ROLLBACK TO SAVEPOINT plasma_import_batch');
      // Find the first bad row: replay one by one, each in its own savepoint.
      for (let i = 0; i < rows.length; i++) {
        // The replay can take long on a big batch: stay cancellable (P2-17).
        checkCancel();
        const row = rows[i] as Cell[];
        await client.query('SAVEPOINT plasma_import_row');
        try {
          await client.query({
            text: buildBatchInsert(job.schema, job.table, targets, 1),
            values: row,
          });
          await client.query('RELEASE SAVEPOINT plasma_import_row');
        } catch (rowErr) {
          throw new RowError(errorText(rowErr), lines[i], sampleOf(row));
        }
      }
      throw batchErr;
    }
    rowsImported += rows.length;
  };

  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    const rows = pending;
    const lines = pendingLines;
    pending = [];
    pendingLines = [];
    await insertBatch(rows, lines);
    checkCancel();
    progress();
  };

  const addRow = async (cells: Cell[], line: number): Promise<void> => {
    pending.push(cells);
    pendingLines.push(line);
    if (pending.length >= batchSize) await flush();
  };

  const runCsv = async (): Promise<void> => {
    const csv = job.csv;
    if (!csv) throw new Error('CSV options are missing');
    if (targets.length === 0) throw new Error('Map at least one column');
    const parser = new CsvParser({
      delimiter: csv.delimiter,
      quote: csv.quote,
      nullString: csv.nullString,
    });
    let skipHeader = csv.header;
    const handle = async (rows: Cell[][], lines: number[]) => {
      for (const [i, r] of rows.entries()) {
        if (skipHeader) {
          skipHeader = false;
          continue;
        }
        rowsRead++;
        // The real file line, so "row 1041" matches what an editor shows
        // (the header and multi-line quoted fields included).
        await addRow(mapCsvRow(r, job.columns), lines[i] ?? rowsRead);
      }
    };
    for await (const chunk of src.chunks) {
      const rows = parser.push(chunk);
      await handle(rows, parser.rowLines);
      checkCancel();
      progress();
    }
    const tail = parser.end();
    await handle(tail, parser.rowLines);
  };

  const runJson = async (): Promise<void> => {
    if (targets.length === 0) throw new Error('Map at least one column');
    const handle = async (texts: string[]) => {
      for (const t of texts) {
        rowsRead++;
        let cells: Cell[];
        try {
          cells = mapJsonRow(parseJsonObject(t), job.columns);
        } catch (err) {
          throw new RowError(errorText(err), rowsRead, t.slice(0, 240));
        }
        await addRow(cells, rowsRead);
      }
    };
    if (job.format === 'ndjson') {
      const lines = new LineSplitter();
      for await (const chunk of src.chunks) {
        await handle(lines.push(chunk));
        checkCancel();
        progress();
      }
      await handle(lines.end());
    } else {
      const arr = new JsonArrayStream();
      try {
        for await (const chunk of src.chunks) {
          await handle(arr.push(chunk));
          checkCancel();
          progress();
        }
        arr.end();
      } catch (err) {
        if (err instanceof RowError || err instanceof CancelledError) throw err;
        throw new RowError(errorText(err), rowsRead + 1, undefined);
      }
    }
  };

  const runSql = async (): Promise<void> => {
    statements = 0;
    let buffer = '';
    const exec = async (text: string) => {
      const kw = leadingKeyword(text);
      // Dump files wrap themselves in a transaction; we already run in one.
      if (kw === 'begin' || kw === 'commit' || kw === 'end' || kw === 'start') return;
      if (kw === 'rollback' || kw === 'abort') {
        throw new RowError(
          'Transaction control (ROLLBACK) is not allowed in an imported file',
          (statements ?? 0) + 1,
          text.slice(0, 240),
        );
      }
      const unsupported = unsupportedStatementReason(text);
      if (unsupported) throw new RowError(unsupported, (statements ?? 0) + 1, text.slice(0, 240));
      try {
        // P1-9: a dump's SET / set_config() must not outlive the import.
        const res = await client.query(localizeSessionSettings(text));
        rowsImported += res.rowCount ?? 0;
      } catch (err) {
        throw new RowError(errorText(err), (statements ?? 0) + 1, text.slice(0, 240));
      }
      statements = (statements ?? 0) + 1;
      rowsRead = statements;
    };
    for await (const chunk of src.chunks) {
      buffer += chunk;
      const parts = splitSqlStatementRanges(buffer);
      // The last statement may continue in the next chunk; keep it.
      const last = parts.pop();
      for (const p of parts) {
        checkCancel();
        await exec(p.text);
      }
      buffer = last ? buffer.slice(last.start) : buffer;
      checkCancel();
      progress();
    }
    for (const p of splitSqlStatementRanges(buffer)) await exec(p.text);
  };

  try {
    await client.query('BEGIN');
    try {
      for (const pre of job.preStatements) await client.query(pre);
      if (job.format === 'csv' || job.format === 'tsv') await runCsv();
      else if (job.format === 'json' || job.format === 'ndjson') await runJson();
      else await runSql();
      await flush();
      checkCancel();
      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // connection gone
      }
      throw err;
    }
    progress(true);
    return { jobId: job.jobId, ok: true, rowsRead, rowsImported, statements };
  } catch (err) {
    src.destroy();
    // A server-side cancel (pg_cancel_backend from importCancel) arrives as a
    // statement error; the user asked for it, so report a cancel.
    if (err instanceof CancelledError || hooks.isCancelled()) {
      return {
        jobId: job.jobId,
        ok: false,
        cancelled: true,
        rowsRead,
        rowsImported: 0,
        statements,
      };
    }
    if (err instanceof RowError) {
      return {
        jobId: job.jobId,
        ok: false,
        rowsRead,
        rowsImported: 0,
        statements,
        error: { message: err.message, row: err.row, sample: err.sample },
      };
    }
    return {
      jobId: job.jobId,
      ok: false,
      rowsRead,
      rowsImported: 0,
      statements,
      error: { message: errorText(err) },
    };
  }
}
