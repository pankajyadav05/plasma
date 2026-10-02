import { quoteIdent } from '@/lib/table-query';

export type Distance = 'cosine' | 'l2' | 'inner';

export const OP_FOR: Record<Distance, string> = {
  cosine: '<=>',
  l2: '<->',
  inner: '<#>',
};

/**
 * Parse what the user typed as the source table: `table` or `schema.table`,
 * each part optionally "quoted". Returns null for anything else, so the
 * builder never emits a placeholder or splices free text into the query.
 */
export function parseTableRef(input: string): { schema?: string; table: string } | null {
  const part = '(?:"((?:[^"]|"")+)"|([A-Za-z_][A-Za-z0-9_$]*))';
  const m = new RegExp(`^\\s*${part}(?:\\s*\\.\\s*${part})?\\s*$`).exec(input);
  if (!m) return null;
  const first = (m[1] ?? m[2])?.replace(/""/g, '"');
  const second = (m[3] ?? m[4])?.replace(/""/g, '"');
  if (!first) return null;
  return second ? { schema: first, table: second } : { table: first };
}

/** `SELECT … ORDER BY col <op> '[…]'::vector LIMIT n` for the chosen anchor, or '' when incomplete. */
export function buildNearestSql(input: {
  anchor: string;
  column: string;
  distance: Distance;
  limit: number;
  table: { schema?: string; table: string } | null;
}): string {
  const { anchor, column, distance, limit, table } = input;
  if (!anchor || !column || !table) return '';
  const op = OP_FOR[distance];
  const target = table.schema
    ? `${quoteIdent(table.schema)}.${quoteIdent(table.table)}`
    : quoteIdent(table.table);
  const col = quoteIdent(column);
  // The anchor is embedded as a literal: pg accepts `'[1,2,3]'::vector`.
  const literal = anchor.replace(/'/g, "''");
  const n = Math.max(1, Math.min(Math.trunc(limit) || 10, 1000));
  return `SELECT *, ${col} ${op} '${literal}'::vector AS distance\nFROM ${target}\nORDER BY ${col} ${op} '${literal}'::vector\nLIMIT ${n};`;
}
