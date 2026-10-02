import { quoteIdent } from '@/lib/table-query';

/**
 * Postgres allows at most 65,535 bind parameters per statement. Mock data
 * can ask for 5,000 rows x many columns in one go, so the INSERT is split
 * into batches that stay under this budget (R-23).
 */
export const MAX_BIND_PARAMS = 60_000;

export interface MockInsertBatch {
  sql: string;
  params: unknown[];
  rows: number;
}

/**
 * Build the INSERT batches for `count` rows. `cell(column, row)` returns the
 * value: `undefined` -> DEFAULT, `null` -> NULL, anything else -> a bind
 * parameter.
 */
export function buildMockInserts(input: {
  schema: string;
  table: string;
  columns: readonly string[];
  count: number;
  cell: (columnIndex: number, row: number) => unknown;
  maxParams?: number;
}): MockInsertBatch[] {
  const { schema, table, columns, count, cell } = input;
  const maxParams = Math.min(input.maxParams ?? MAX_BIND_PARAMS, 65_000);
  const target = `${quoteIdent(schema)}.${quoteIdent(table)}`;
  const colList = columns.map(quoteIdent).join(', ');
  const perRow = Math.max(1, columns.length);
  const rowsPerBatch = Math.max(1, Math.floor(maxParams / perRow));

  const batches: MockInsertBatch[] = [];
  for (let start = 0; start < count; start += rowsPerBatch) {
    const end = Math.min(count, start + rowsPerBatch);
    const params: unknown[] = [];
    const valueRows: string[] = [];
    for (let r = start; r < end; r++) {
      const cells: string[] = [];
      for (let c = 0; c < columns.length; c++) {
        const v = cell(c, r);
        if (v === undefined) cells.push('DEFAULT');
        else if (v === null) cells.push('NULL');
        else {
          params.push(v);
          cells.push(`$${params.length}`);
        }
      }
      valueRows.push(`(${cells.join(', ')})`);
    }
    batches.push({
      sql: `INSERT INTO ${target} (${colList}) VALUES\n${valueRows.join(',\n')}`,
      params,
      rows: end - start,
    });
  }
  return batches;
}
