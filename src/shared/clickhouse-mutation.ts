import { splitSqlStatements, sqlSkeleton } from './sql-statements';

/**
 * ClickHouse mutations. `ALTER TABLE … UPDATE` / `… DELETE` do not run in the
 * statement: the server queues a background job that rewrites whole data
 * parts, cannot be rolled back and may take a long time on a big table.
 * Lightweight `DELETE FROM` / `UPDATE … SET` are asynchronous in the same
 * sense (rows are masked, then physically removed by later merges).
 */
export type ClickhouseMutationKind = 'alter-update' | 'alter-delete' | 'delete' | 'update';

/** The first mutation among the statements of `sql`, or null. */
export function clickhouseMutation(sql: string): ClickhouseMutationKind | null {
  for (const statement of splitSqlStatements(sql)) {
    const sk = sqlSkeleton(statement).trim().toLowerCase();
    if (/^alter\s+table\s+[^;]*?\s(?:on\s+cluster\s+\S+\s+)?update\s/.test(sk))
      return 'alter-update';
    if (/^alter\s+table\s+[^;]*?\s(?:on\s+cluster\s+\S+\s+)?delete\s+where\b/.test(sk)) {
      return 'alter-delete';
    }
    if (/^delete\s+from\s/.test(sk)) return 'delete';
    if (/^update\s+\S+\s+set\s/.test(sk)) return 'update';
  }
  return null;
}

export const CLICKHOUSE_MUTATION_WARNING =
  'ClickHouse runs this as an asynchronous mutation: it rewrites data parts in the background, can take a long time on large tables and cannot be rolled back. The statement returns before the change is complete (check system.mutations).';
