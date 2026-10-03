import type { QueryResult } from '@shared/protocol';
import { dialectFor } from '@shared/sql-dialect';

/**
 * Column profile of a DuckDB view or table, from `SUMMARIZE`: type, null
 * share, distinct estimate and min / max per column.
 */
export interface ColumnProfile {
  column: string;
  type: string;
  /** 0–100, or null when the engine did not say. */
  nullPercent: number | null;
  /** HyperLogLog-style estimate, so approximate. */
  distinct: number | null;
  min: string | null;
  max: string | null;
  count: number | null;
}

export function summarizeSql(schema: string, table: string): string {
  return `SUMMARIZE ${dialectFor('duckdb').qualify(schema, table)}`;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const text = (v: unknown): string | null =>
  v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v);

/** Read a `SUMMARIZE` result by column name, so a reordered result still parses. */
export function parseSummarize(result: Pick<QueryResult, 'columns' | 'rows'>): ColumnProfile[] {
  const idx = (name: string) => result.columns.findIndex((c) => c.name === name);
  const at = {
    column: idx('column_name'),
    type: idx('column_type'),
    nulls: idx('null_percentage'),
    distinct: idx('approx_unique'),
    min: idx('min'),
    max: idx('max'),
    count: idx('count'),
  };
  if (at.column < 0) return [];
  return result.rows.map((row) => ({
    column: String(row[at.column] ?? ''),
    type: at.type >= 0 ? String(row[at.type] ?? '').toLowerCase() : '',
    nullPercent: at.nulls >= 0 ? num(row[at.nulls]) : null,
    distinct: at.distinct >= 0 ? num(row[at.distinct]) : null,
    min: at.min >= 0 ? text(row[at.min]) : null,
    max: at.max >= 0 ? text(row[at.max]) : null,
    count: at.count >= 0 ? num(row[at.count]) : null,
  }));
}
