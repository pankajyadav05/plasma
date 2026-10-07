import { leadingKeyword, sqlSkeleton } from './sql-statements';

/**
 * Text-level screens for the MySQL / MariaDB read-only paths. Like the
 * Postgres one (`pg-readonly-sql.ts`) they are defence in depth: the driver
 * also re-asserts `SET SESSION TRANSACTION READ ONLY` before every statement,
 * and the aux session runs lookups inside `START TRANSACTION READ ONLY`.
 *
 * MySQL runs `/*! … *\/` (and MariaDB `/*M! … *\/`) comments as code, so they
 * are unwrapped first; the generic skeleton would otherwise drop them as
 * comments and a flip hidden in one would go unseen.
 */

/** `/*!50000 text *\/` and `/*M!100000 text *\/` become plain `text`. */
export function unwrapExecutableComments(sql: string): string {
  return sql.replace(/\/\*M?!\d*([\s\S]*?)\*\//g, ' $1 ');
}

const SESSION_FLAG = /\b(tx_read_only|transaction_read_only)\b/;

/**
 * Why a statement on a read-only connection tries to leave read-only mode, or
 * null. `START TRANSACTION READ WRITE` is the one that matters most: it makes
 * the transaction writable whatever the session default says.
 */
export function mysqlReadOnlyEscapeReason(sql: string): string | null {
  const sk = sqlSkeleton(unwrapExecutableComments(sql));
  if (!sk) return null;
  if (/\bread\s+write\b/.test(sk)) return 'starting a read-write transaction';
  if (SESSION_FLAG.test(sk)) return 'changing the transaction read-only setting';
  // The statement text is a string the screen cannot see into.
  if (/^(prepare|execute)\b/.test(sk)) return 'a prepared statement';
  return null;
}

const AUX_READ_HEADS = new Set([
  'select',
  'with',
  'show',
  'describe',
  'desc',
  'explain',
  'values',
  'table',
]);

/**
 * Why a statement may not run on the read-only aux paths (lookups and AI
 * queries), or null. A positive list: MariaDB lets DDL through a READ ONLY
 * transaction (it commits first, then runs), so "the transaction is read-only"
 * is not enough there.
 */
export function mysqlAuxReadViolation(sql: string): string | null {
  const text = unwrapExecutableComments(sql);
  const head = leadingKeyword(text);
  if (!AUX_READ_HEADS.has(head)) {
    return head ? `${head.toUpperCase()} is not a read` : 'empty statement';
  }
  const sk = sqlSkeleton(text);
  if (/\binto\s+(outfile|dumpfile)\b/.test(sk)) return 'SELECT … INTO OUTFILE writes a file';
  return null;
}
