import { type Cell, type JsonObject, jsonCell } from './import-parse';
import { checkIdent, qualifiedName, quoteIdent } from './pg-ddl';

/**
 * Batched, parameterised INSERTs for imports. Values travel as text
 * parameters and Postgres coerces them to the column types, so the same
 * plan works for every type the server can parse from text.
 */

/** Postgres allows 65535 bind parameters per statement. */
export const MAX_BIND_PARAMS = 30000;
export const DEFAULT_BATCH_ROWS = 1000;

export function rowsPerBatch(columnCount: number, wanted = DEFAULT_BATCH_ROWS): number {
  if (columnCount <= 0) return 1;
  return Math.max(1, Math.min(wanted, Math.floor(MAX_BIND_PARAMS / columnCount)));
}

/** `INSERT INTO s.t (a, b) VALUES ($1, $2), ($3, $4)` for `rowCount` rows. */
export function buildBatchInsert(
  schema: string,
  table: string,
  targets: readonly string[],
  rowCount: number,
): string {
  if (targets.length === 0) throw new Error('Map at least one column');
  if (rowCount < 1) throw new Error('Nothing to insert');
  const cols = targets.map((c) => quoteIdent(checkIdent(c, 'Column name'))).join(', ');
  const tuples: string[] = [];
  let n = 1;
  for (let r = 0; r < rowCount; r++) {
    const ph: string[] = [];
    for (let c = 0; c < targets.length; c++) ph.push(`$${n++}`);
    tuples.push(`(${ph.join(', ')})`);
  }
  return `INSERT INTO ${qualifiedName(schema, table)} (${cols}) VALUES ${tuples.join(', ')}`;
}

export interface ColumnMapping {
  /** Target column name. */
  target: string;
  /** CSV column index, or JSON key. */
  source: number | string;
}

export function mapCsvRow(row: readonly Cell[], mapping: readonly ColumnMapping[]): Cell[] {
  return mapping.map((m) => (typeof m.source === 'number' ? (row[m.source] ?? null) : null));
}

export function mapJsonRow(obj: JsonObject, mapping: readonly ColumnMapping[]): Cell[] {
  return mapping.map((m) => jsonCell(obj[String(m.source)]));
}
