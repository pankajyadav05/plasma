import { quoteIdent } from '@/lib/table-query';
import type { Filter } from '@/lib/table-query';
import type { NlFilterRow } from '@shared/ai-tasks';

/** Suggested filter rows as the grid's filter model. */
export function nlRowsToFilters(rows: readonly NlFilterRow[], newId: () => string): Filter[] {
  return rows.map((r) => ({ id: newId(), column: r.column, op: r.op, value: r.value }));
}

/** A read-only SELECT for a WHERE fragment the filter model can't express. */
export function whereFragmentQuery(schema: string, table: string, where: string): string {
  return `SELECT *\nFROM ${quoteIdent(schema)}.${quoteIdent(table)}\nWHERE ${where.trim()}\nLIMIT 200;`;
}
