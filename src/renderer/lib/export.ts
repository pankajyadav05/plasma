import { maskResultForClipboard } from '@/features/presentation/presentation';
import { type CsvOptions, exportMime, formatResultString } from '@shared/export-format';
import type { QueryResult } from '@shared/protocol';
import { isSingleSqlStatement, looksLikeWriteSql } from '@shared/sql-statements';
import { type Filter, type TableSort, buildDataSql, quoteIdent } from './table-query';

/**
 * Result set export helpers. CSV / JSON / SQL formatting lives in
 * `@shared/export-format` (one implementation for clipboard, in-renderer
 * download and the worker's streamed file export — F7). The worker
 * returns Postgres text for dates, timestamps, intervals, bytea, numeric
 * and arrays, so values are written exactly as the server printed them.
 */

export type ExportFormat = 'csv' | 'json' | 'sql';

export interface ExportOptions {
  /** Quoted INSERT target for SQL (see `exportTargetTable`). */
  targetTable?: string;
  /** CSV dialect from Settings → Data → CSV export. */
  csv?: CsvOptions;
}

/** `"schema"."table"` for SQL INSERT export, or undefined if unknown. */
export function exportTargetTable(
  schema?: string | null,
  table?: string | null,
): string | undefined {
  if (!schema || !table) return undefined;
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

/**
 * Server-side "export everything" source (F7 / PF9): the worker streams the
 * query straight to the file, so the export is not limited to the loaded
 * page or the 10k-row display cap.
 */
export interface FullExportSource {
  sql: string;
  params?: unknown[];
  /** Scope label, e.g. "Whole table" or "Full result". */
  label: string;
  targetTable?: string;
}

/** Table tab → unpaged SELECT with the tab's filters, sort and columns. */
export function tableFullExport(input: {
  schema: string;
  table: string;
  allColumns: string[];
  hiddenColumns: Set<string>;
  sort: TableSort[];
  filters: Filter[];
  primaryKey?: string[];
}): FullExportSource {
  const { sql, params } = buildDataSql({
    ...input,
    page: 0,
    pageSize: 1,
    unpaged: true,
  });
  const filtered = input.filters.length > 0;
  return {
    sql,
    params,
    label: filtered ? 'All matching' : 'Whole table',
    targetTable: exportTargetTable(input.schema, input.table),
  };
}

/**
 * SQL result → re-run the statement unbounded, but only when it is a
 * single read-only query and the loaded result was truncated. DML is
 * never re-executed for an export.
 */
export function queryFullExport(result: QueryResult): FullExportSource | null {
  const sql = result.sql?.trim();
  if (!result.truncated || !sql) return null;
  if (!isSingleSqlStatement(sql) || looksLikeWriteSql(sql)) return null;
  return { sql, label: 'Full result' };
}

function formatResult(result: QueryResult, format: ExportFormat, opts?: ExportOptions): string {
  return formatResultString(result.columns, result.rows, format, {
    targetTable: opts?.targetTable,
    csv: opts?.csv,
    bom: false,
  });
}

export function exportResult(
  result: QueryResult,
  format: ExportFormat,
  filename = 'plasma',
  opts?: ExportOptions,
) {
  download(formatResult(result, format, opts), `${filename}.${format}`, exportMime(format));
}

/**
 * Serialize the result set to the chosen format and write it to the
 * clipboard. Used by the toolbar Export menu's Copy column.
 */
export async function copyResultToClipboard(
  result: QueryResult,
  format: ExportFormat,
  opts?: ExportOptions,
): Promise<void> {
  await navigator.clipboard.writeText(formatResult(maskResultForClipboard(result), format, opts));
}

/** Clipboard-only table formats (no file download counterpart). */
export type ClipboardFormat = 'markdown' | 'html' | 'tsv';

export async function copyResultAs(result: QueryResult, format: ClipboardFormat): Promise<void> {
  await navigator.clipboard.writeText(formatResultAs(maskResultForClipboard(result), format));
}

export function formatResultAs(result: QueryResult, format: ClipboardFormat): string {
  switch (format) {
    case 'markdown':
      return toMarkdown(result);
    case 'html':
      return toHtml(result);
    case 'tsv':
      return toTsv(result);
  }
}

function plainCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function toMarkdown(result: QueryResult): string {
  const cell = (v: unknown) =>
    v === null || v === undefined
      ? 'NULL'
      : plainCell(v).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  const header = `| ${result.columns.map((c) => cell(c.name)).join(' | ')} |`;
  const rule = `| ${result.columns.map(() => '---').join(' | ')} |`;
  const body = result.rows.map((row) => `| ${row.map(cell).join(' | ')} |`);
  return [header, rule, ...body].join('\n');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toHtml(result: QueryResult): string {
  const head = result.columns.map((c) => `<th>${escapeHtml(c.name)}</th>`).join('');
  const body = result.rows
    .map((row) => `<tr>${row.map((v) => `<td>${escapeHtml(plainCell(v))}</td>`).join('')}</tr>`)
    .join('\n');
  return `<table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table>`;
}

function toTsv(result: QueryResult): string {
  const cell = (v: unknown) => plainCell(v).replace(/[\t\r\n]+/g, ' ');
  const header = result.columns.map((c) => cell(c.name)).join('\t');
  return [header, ...result.rows.map((row) => row.map(cell).join('\t'))].join('\n');
}

/**
 * Return a new QueryResult containing only the rows whose original
 * index is in `indices`. Order follows the iteration order of the
 * input set so callers can pre-sort. Columns and metadata are
 * preserved verbatim.
 */
export function pickRows(result: QueryResult, indices: Iterable<number>): QueryResult {
  const ordered = Array.from(indices).sort((a, b) => a - b);
  const rows = ordered.filter((i) => i >= 0 && i < result.rows.length).map((i) => result.rows[i]);
  return { ...result, rows, rowCount: rows.length };
}

function download(content: string, filename: string, mime: string) {
  // Prepend UTF-8 BOM for CSV so Excel opens it correctly
  const prefix = mime.startsWith('text/csv') ? '\uFEFF' : '';
  const blob = new Blob([prefix + content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Give the browser a tick before revoking so the download actually starts
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Copy a single cell value to the clipboard. Normalizes the same way
 * the grid renders it (null → empty string, objects → JSON).
 */
export async function copyCellToClipboard(value: unknown): Promise<void> {
  let str: string;
  if (value === null || value === undefined) str = '';
  else if (typeof value === 'object') {
    try {
      str = JSON.stringify(value);
    } catch {
      str = String(value);
    }
  } else {
    str = String(value);
  }
  await navigator.clipboard.writeText(str);
}
