import { splitSqlStatements, unsupportedStatementReason } from '@/lib/sql-split';
import type { QueryResult } from '@shared/protocol';

/**
 * The editor's statement pipeline without the tab: split a script with the
 * quote/comment-aware tokenizer, refuse statements the driver can't run,
 * apply the row limit and stop at the first failure. The notebook runs its
 * SQL cells through this so a cell behaves exactly like the editor (R-12).
 */
export interface StatementsOutcome {
  results: QueryResult[];
  error?: { message: string; statementIndex: number; total: number; sql: string };
}

export async function runStatements(
  script: string,
  opts: {
    /** Row limit from the editor's menu; null = no limit. */
    rowLimit: number | null;
    run: (sql: string, maxRows?: number) => Promise<QueryResult>;
    /** Checked before each statement after the first (connection changed, cancelled…). */
    shouldStop?: () => boolean;
  },
): Promise<StatementsOutcome> {
  const statements = splitSqlStatements(script);
  const results: QueryResult[] = [];
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i]!;
    if (i > 0 && opts.shouldStop?.()) {
      return {
        results,
        error: {
          message: 'stopped — the connection changed while the script was running',
          statementIndex: i,
          total: statements.length,
          sql: stmt.text,
        },
      };
    }
    try {
      const unsupported = unsupportedStatementReason(stmt.text);
      if (unsupported) throw new Error(unsupported);
      const result =
        opts.rowLimit === null
          ? await opts.run(stmt.text)
          : await opts.run(stmt.text, opts.rowLimit);
      results.push({ ...result, sql: stmt.text });
    } catch (err) {
      return {
        results,
        error: {
          message: err instanceof Error ? err.message : String(err),
          statementIndex: i,
          total: statements.length,
          sql: stmt.text,
        },
      };
    }
  }
  return { results };
}

/** The result a single-result view should show: the last one that has columns, else the last. */
export function pickDisplayResult(results: readonly QueryResult[]): QueryResult | undefined {
  for (let i = results.length - 1; i >= 0; i--) {
    if (results[i]!.columns.length > 0) return results[i];
  }
  return results[results.length - 1];
}
