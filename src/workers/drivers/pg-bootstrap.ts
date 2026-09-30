import { splitSqlStatements } from '@shared/sql-statements';

/**
 * C28: statements a connection runs right after it is established
 * (`SET search_path…`, `SET ROLE…`, `SET TIME ZONE…`). They run on the
 * primary session only — the one that carries user queries — so a `SET ROLE`
 * doesn't leak to the aux connection Plasma uses for its own lookups.
 * The first failure aborts the connect with the statement that caused it.
 */
export async function runBootstrapSql(
  client: { query(sql: string): Promise<unknown> },
  sql: string | undefined,
): Promise<number> {
  const statements = splitSqlStatements(sql ?? '');
  for (const stmt of statements) {
    try {
      await client.query(stmt);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const preview = stmt.replace(/\s+/g, ' ').slice(0, 80);
      throw new Error(`Bootstrap SQL failed at "${preview}": ${detail}`);
    }
  }
  return statements.length;
}
