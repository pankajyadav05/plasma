/**
 * Text-level screens for the MySQL / MariaDB read-only paths. Like the
 * Postgres one (`pg-readonly-sql.ts`) they are defence in depth: the driver
 * also re-asserts `SET SESSION TRANSACTION READ ONLY` before every statement,
 * and the aux session runs lookups inside `START TRANSACTION READ ONLY`.
 *
 * They read the statement the way MySQL does, which is not the way Postgres
 * does: block comments do not nest, `#` and `-- ` start a line comment,
 * strings take backslash escapes in both quote styles, and a versioned comment
 * (slash-star-bang, MariaDB slash-star-M-bang) is code the server runs. A screen that lexed it
 * the Postgres way could be walked past with one comment, so a versioned
 * comment is refused outright.
 */

export interface MysqlSkeleton {
  /** Lower-cased, comments dropped, strings `''`, quoted identifiers `` `_` ``. */
  text: string;
  /** The statement holds a versioned comment: the server would run its content. */
  executableComment: boolean;
}

/** The statement as MySQL tokenises it, reduced to what keyword checks may look at. */
export function mysqlSkeleton(sql: string): MysqlSkeleton {
  let out = '';
  let executableComment = false;
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i] as string;
    const next = sql[i + 1];
    if (c === '/' && next === '*') {
      if (sql[i + 2] === '!' || (sql[i + 2] === 'M' && sql[i + 3] === '!')) {
        executableComment = true;
      }
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      out += ' ';
      continue;
    }
    if (
      c === '#' ||
      (c === '-' && next === '-' && (i + 2 >= n || /\s/.test(sql[i + 2] as string)))
    ) {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      out += ' ';
      continue;
    }
    if (c === "'" || c === '"') {
      i++;
      while (i < n) {
        const d = sql[i];
        if (d === '\\') i += 2;
        else if (d === c && sql[i + 1] === c) i += 2;
        else if (d === c) {
          i++;
          break;
        } else i++;
      }
      out += "''";
      continue;
    }
    if (c === '`') {
      i++;
      while (i < n) {
        if (sql[i] === '`' && sql[i + 1] === '`') i += 2;
        else if (sql[i] === '`') {
          i++;
          break;
        } else i++;
      }
      out += '`_`';
      continue;
    }
    out += c;
    i++;
  }
  return { text: out.replace(/\s+/g, ' ').trim().toLowerCase(), executableComment };
}

const SESSION_FLAG = /\b(tx_read_only|transaction_read_only)\b/;

/**
 * Why a statement on a read-only connection tries to leave read-only mode, or
 * null. `START TRANSACTION READ WRITE` is the one that matters most: it makes
 * the transaction writable whatever the session default says.
 */
export function mysqlReadOnlyEscapeReason(sql: string): string | null {
  const sk = mysqlSkeleton(sql);
  if (sk.executableComment) return 'a version-specific comment';
  const t = sk.text;
  if (!t) return null;
  if (/\bread\s+write\b/.test(t)) return 'starting a read-write transaction';
  // Reading the flag (`SELECT @@transaction_read_only`) is fine; assigning it is not.
  if (/^set\b/.test(t) && SESSION_FLAG.test(t)) {
    return 'changing the transaction read-only setting';
  }
  // The statement text is a string the screen cannot see into.
  if (/^(prepare|execute)\b/.test(t)) return 'a prepared statement';
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
  const sk = mysqlSkeleton(sql);
  if (sk.executableComment) return 'a version-specific comment is not allowed here';
  const head = /^[\s(]*([a-z]+)/.exec(sk.text)?.[1] ?? '';
  if (!AUX_READ_HEADS.has(head)) {
    return head ? `${head.toUpperCase()} is not a read` : 'empty statement';
  }
  if (/\binto\s+(outfile|dumpfile)\b/.test(sk.text)) return 'SELECT … INTO OUTFILE writes a file';
  return null;
}
