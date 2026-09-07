/**
 * Cheap SQL heuristics used by query execution and the prod gate.
 * Not a parser — false positives only cost an extra confirm or introspect.
 */

/**
 * Anything that could destroy or rewrite data without trivial recovery.
 * Used by the prod gate so accidental DELETE/TRUNCATE/DROP on a
 * production-tagged connection trips a confirm dialog. UPDATE without
 * a WHERE clause counts. Leading comments / whitespace are stripped.
 */
export function looksDestructive(sql: string): boolean {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*--.*$/gm, '')
    .trim();
  const lower = stripped.toLowerCase();
  if (/^(drop|truncate)\b/.test(lower)) return true;
  if (/^delete\b/.test(lower)) return true;
  // UPDATE without WHERE — we eyeball for the keyword and reject
  // statements that DON'T contain a `where` token after `update`.
  if (/^update\b/.test(lower) && !/\bwhere\b/.test(lower)) return true;
  // ALTER TABLE … DROP COLUMN / DROP CONSTRAINT
  if (/^alter\b.*\bdrop\b/.test(lower)) return true;
  return false;
}

/**
 * Cheap heuristic for DDL detection. We strip leading comments/whitespace
 * and look for a top-level keyword that implies the schema graph has
 * changed. False positives on DML containing the word `create` inside a
 * string literal are acceptable (worst case is one extra introspect call).
 */
export function looksLikeDdl(sql: string): boolean {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*--.*$/gm, '')
    .trim()
    .toLowerCase();
  return /^(create|alter|drop|rename|truncate|comment|grant|revoke|vacuum|reindex|cluster)\b/.test(
    stripped,
  );
}
