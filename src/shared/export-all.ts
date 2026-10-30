import { jsonReplacer, rowToObject } from './export-format';
import type { ColumnMeta, QueryResult } from './protocol';

/**
 * "Export all results": every result set of a multi-statement run in one file,
 * either an Excel workbook (one sheet per result) or a .zip of CSV / JSON files.
 * This module only names things; `src/main/export-all.ts` writes the bytes.
 */

export type ExportAllFormat = 'xlsx' | 'csv' | 'json';

export interface NamedResult {
  /** "Result 2 · orders": shown to the user, then turned into a sheet or file name. */
  label: string;
  columns: ColumnMeta[];
  rows: unknown[][];
  /** The run stopped loading rows at the cap; only the loaded ones are here. */
  truncated?: boolean;
}

/** Excel's own limit for a sheet name. */
export const SHEET_NAME_MAX = 31;

/** The table a SELECT reads first (`FROM a.b`, quoted or not), or null. */
export function firstTableOf(sql: string | undefined): string | null {
  if (!sql) return null;
  const noComments = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ');
  const m =
    /\bfrom\s+((?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[\w$]+)(?:\s*\.\s*(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[\w$]+))*)/i.exec(
      noComments,
    );
  if (!m?.[1]) return null;
  const parts = m[1].split('.').map((p) => p.trim().replace(/^["`[]|["`\]]$/g, ''));
  return parts[parts.length - 1] || null;
}

/**
 * The results worth exporting, labelled the way the result tabs number them
 * ("Result 1"), plus the table they read when one is obvious. Statements that
 * returned no columns (INSERT, UPDATE, SET…) are left out.
 */
export function exportableResults(results: readonly QueryResult[]): NamedResult[] {
  const out: NamedResult[] = [];
  results.forEach((r, i) => {
    if (r.columns.length === 0) return;
    const table = firstTableOf(r.sql);
    out.push({
      label: table ? `Result ${i + 1} · ${table}` : `Result ${i + 1}`,
      columns: r.columns,
      rows: r.rows,
      truncated: r.truncated,
    });
  });
  return out;
}

/** Sheet names: no `[]:*?/\`, at most 31 characters, unique regardless of case. */
export function sheetNames(labels: readonly string[]): string[] {
  const used = new Set<string>();
  return labels.map((label, i) => {
    const base =
      label
        .replace(/[[\]:*?/\\]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^'+|'+$/g, '') || `Sheet ${i + 1}`;
    let name = base.slice(0, SHEET_NAME_MAX).trim();
    for (let n = 2; used.has(name.toLowerCase()); n++) {
      const suffix = ` (${n})`;
      name = base.slice(0, SHEET_NAME_MAX - suffix.length).trim() + suffix;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

/** File names inside the zip: `result-2-orders.csv`, unique. */
export function zipEntryNames(labels: readonly string[], extension: string): string[] {
  const used = new Set<string>();
  return labels.map((label, i) => {
    const stem =
      label
        .toLowerCase()
        .replace(/[^\p{L}\p{N}_]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || `result-${i + 1}`;
    let name = `${stem}.${extension}`;
    for (let n = 2; used.has(name); n++) name = `${stem}-${n}.${extension}`;
    used.add(name);
    return name;
  });
}

/** The file the save dialog suggests: `.xlsx` for a workbook, `.zip` for the rest. */
export function exportAllExtension(format: ExportAllFormat): 'xlsx' | 'zip' {
  return format === 'xlsx' ? 'xlsx' : 'zip';
}

/**
 * Every result as one JSON document for the clipboard, keyed by result:
 *
 *   { "Result 1 · orders": [{ "id": 1, … }], "Result 2": [{ "n": 12 }] }
 *
 * Rows are objects like the single-result JSON export; keys stay unique.
 */
export function formatAllResultsJson(results: readonly NamedResult[]): string {
  const doc: Record<string, Record<string, unknown>[]> = {};
  const used = new Set<string>();
  for (const r of results) {
    let key = r.label;
    for (let n = 2; used.has(key); n++) key = `${r.label} (${n})`;
    used.add(key);
    doc[key] = r.rows.map((row) => rowToObject(r.columns, row));
  }
  return JSON.stringify(doc, jsonReplacer, 2);
}
