/**
 * Cheap SQL heuristics used by query execution and the prod gate.
 * Not a parser — false positives only cost an extra confirm or introspect.
 *
 * Both checks run on a comment- and literal-free skeleton of the
 * statement (see `sqlSkeleton` in shared/sql-statements.ts), so a trailing
 * `-- where` or a `'drop'` inside a string can't fool them.
 */
import { leadingKeyword, looksDestructiveSql, looksLikeWriteSql } from '@shared/sql-statements';

/**
 * Anything that could destroy or rewrite data without trivial recovery.
 * Used by the prod gate so accidental DELETE/TRUNCATE/DROP on a
 * production-tagged connection trips a confirm dialog. Also: UPDATE
 * without WHERE, multi-line ALTER … DROP/RENAME, MERGE, upserts,
 * data-modifying CTEs, DO, CALL and COPY … FROM.
 */
export function looksDestructive(sql: string): boolean {
  return looksDestructiveSql(sql);
}

/** True when the statement may write (used for read-only and Explain checks). */
export function looksLikeWrite(sql: string): boolean {
  return looksLikeWriteSql(sql);
}

/**
 * Cheap heuristic for DDL detection: a top-level keyword that implies the
 * schema graph has changed. False positives cost one extra introspect.
 */
export function looksLikeDdl(sql: string): boolean {
  return /^(create|alter|drop|rename|truncate|comment|grant|revoke|vacuum|reindex|cluster)$/.test(
    leadingKeyword(sql),
  );
}
