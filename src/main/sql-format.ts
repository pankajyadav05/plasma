import { format } from 'sql-formatter';
import { logger } from './logger';

/**
 * SQL pretty-printer. Lives in main so we can swap engines (sql-formatter,
 * pgFormatter) later without re-bundling the renderer. Failure mode is
 * always "return the input unchanged" — a half-broken SQL editor must
 * never lose the user's text.
 */
export function formatSql(sql: string): string {
  if (!sql || !sql.trim()) return sql;
  try {
    return format(sql, {
      language: 'postgresql',
      keywordCase: 'upper',
      indentStyle: 'standard',
      logicalOperatorNewline: 'before',
      tabWidth: 2,
    });
  } catch (err) {
    // The error can quote a slice of the user's SQL; keep only its kind (SC-27).
    logger.warn(
      '[plasma] sql-formatter rejected input:',
      err instanceof Error ? err.name : 'error',
    );
    return sql;
  }
}
