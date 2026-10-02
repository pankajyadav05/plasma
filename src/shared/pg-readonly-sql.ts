import { sqlSkeleton } from './sql-statements';

/**
 * Text-level screen for SQL that tries to turn a read-only Postgres session
 * back to read-write (SC-02). This is defence in depth only: the boundary
 * that holds is the driver re-asserting `default_transaction_read_only = on`
 * before every statement (see `workers/drivers/pg-readonly.ts`), because
 * names built at run time (`'default_'||'transaction_read_only'`) can never
 * be caught by a text screen.
 *
 * Works on the sqlSkeleton, so literals and comments cannot trip it
 * (`SELECT 'read write'` is fine) or hide a keyword.
 */

const GUC_READ_ONLY = /\b(default_)?transaction_read_only\b/;

export function pgReadOnlyEscapeReason(sql: string): string | null {
  const sk = sqlSkeleton(sql).trim();
  if (!sk) return null;
  if (GUC_READ_ONLY.test(sk)) return 'changing the transaction read-only setting';
  if (/\bread\s+write\b/.test(sk)) return 'starting a read-write transaction';
  if (/\bset_config\s*\(/.test(sk)) return 'set_config()';
  // `SET "quoted_guc" = …` hides the name from the skeleton.
  if (/^set\s+(session\s+|local\s+)?"/.test(sk)) return 'setting a quoted parameter';
  // RESET ALL / DISCARD ALL also drop the bootstrap role and search_path.
  if (/^(reset|discard)\s+all\b/.test(sk))
    return sk.startsWith('reset') ? 'RESET ALL' : 'DISCARD ALL';
  if (/^reset\s+"/.test(sk)) return 'resetting a quoted parameter';
  if (/^do\b/.test(sk)) {
    // The body is a string to the skeleton, so look at the raw text.
    if (/\b(execute|set_config|read_only|read\s+write)\b/i.test(sql)) {
      return 'a DO block that could change session settings';
    }
  }
  return null;
}
