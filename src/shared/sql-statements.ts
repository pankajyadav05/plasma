import { splitSqlStatementRanges } from './sql-split';

/**
 * Split a SQL string into statements, respecting Postgres quoting and
 * comments. Shared by the renderer multi-statement runner and the AI
 * read-only executor (which rejects anything other than a single
 * statement before the database ever sees it).
 *
 * Handles:
 *   - Single quotes (`'...'`) with `''` escapes
 *   - Double-quoted identifiers (`"..."`) with `""` escapes
 *   - Dollar-quoted strings (`$$...$$`, `$tag$...$tag$`)
 *   - Line comments (`-- …\n`)
 *   - Nested block comments (`/* … *\/`)
 *
 * Returns trimmed, non-empty statement strings (without trailing `;`).
 */
export function splitSqlStatements(sql: string): string[] {
  // One tokenizer for renderer + worker (F18): see `./sql-split`.
  return splitSqlStatementRanges(sql).map((s) => s.text);
}

/** True when `sql` contains exactly one non-empty statement. */
export function isSingleSqlStatement(sql: string): boolean {
  return splitSqlStatements(sql).length === 1;
}

const IDENT_CHAR = /[A-Za-z0-9_$]/;

/**
 * Lower-cased "skeleton" of a SQL string for keyword heuristics: comments
 * are dropped, string literals become `''`, quoted identifiers become
 * `"_"` and dollar-quoted bodies become `''` too. So `-- where` in a trailing
 * comment or `'drop table'` inside a literal can never satisfy (or trip)
 * a keyword check. Handles `E'…'` backslash escapes and does not treat a
 * `$` inside an identifier (`a$b`) as a dollar quote.
 */
export function sqlSkeleton(sql: string): string {
  let out = '';
  let i = 0;
  const N = sql.length;
  while (i < N) {
    const c = sql[i]!;
    const prev = i > 0 ? sql[i - 1]! : '';
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i + 2);
      i = nl === -1 ? N : nl + 1;
      out += ' ';
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < N && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else i++;
      }
      out += ' ';
      continue;
    }
    if (c === "'") {
      const backslash = /[eE]/.test(prev) && !IDENT_CHAR.test(sql[i - 2] ?? '');
      i++;
      while (i < N) {
        if (backslash && sql[i] === '\\') i += 2;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") {
          i++;
          break;
        } else i++;
      }
      out += "''";
      continue;
    }
    if (c === '"') {
      i++;
      while (i < N) {
        if (sql[i] === '"' && sql[i + 1] === '"') i += 2;
        else if (sql[i] === '"') {
          i++;
          break;
        } else i++;
      }
      out += '"_"';
      continue;
    }
    if (c === '$' && !IDENT_CHAR.test(prev)) {
      const tagMatch = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/y;
      tagMatch.lastIndex = i;
      const m = tagMatch.exec(sql);
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        i = end === -1 ? N : end + m[0].length;
        out += " '' ";
        continue;
      }
    }
    out += c;
    i++;
  }
  return out.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** First keyword of a statement (after comments), lower-cased. */
export function leadingKeyword(sql: string): string {
  const m = /^[a-z]+/.exec(sqlSkeleton(sql).replace(/^\(+\s*/, ''));
  return m ? m[0] : '';
}

/**
 * Anything that could destroy or rewrite data without trivial recovery —
 * the prod-gate trigger. Not a parser: false positives only cost an extra
 * confirm. Covers DROP / TRUNCATE / DELETE, UPDATE without WHERE, ALTER …
 * DROP / RENAME, MERGE, INSERT … ON CONFLICT DO UPDATE, data-modifying
 * CTEs, DO blocks, CALL and COPY … FROM.
 */
export function looksDestructiveSql(sql: string): boolean {
  const s = sqlSkeleton(sql);
  const head = leadingKeyword(sql);
  if (head === 'drop' || head === 'truncate' || head === 'delete') return true;
  if (head === 'update' && !/\bwhere\b/.test(s)) return true;
  if (head === 'alter' && /\b(drop|rename)\b/.test(s)) return true;
  if (head === 'merge' || head === 'do' || head === 'call') return true;
  if (head === 'copy' && /\bfrom\b/.test(s)) return true;
  if (/\bon conflict\b.*\bdo update\b/.test(s)) return true;
  if (head === 'with' && /\b(delete|update|merge|truncate)\b/.test(s)) return true;
  // EXPLAIN ANALYZE executes its statement.
  if (head === 'explain' && explainAnalyzes(s)) return looksDestructiveSql(explainTarget(s));
  return false;
}

/** The statement an `EXPLAIN [options]` skeleton wraps. */
function explainTarget(skeleton: string): string {
  return skeleton.replace(/^explain\s*(\([^)]*\)\s*|(analy[sz]e|verbose)\s+)*/, '');
}

function explainAnalyzes(skeleton: string): boolean {
  const opts = skeleton.slice(0, skeleton.length - explainTarget(skeleton).length);
  return /\banaly[sz]e\b(?!\s*(false|off|0)\b)/.test(opts);
}

/** Statements that only read (SELECT / SHOW / VALUES / TABLE / plain EXPLAIN …). */
const READ_HEADS = new Set(['select', 'show', 'values', 'table', 'explain', 'with']);

/**
 * True when a statement may change data or schema. Used to decide whether
 * EXPLAIN ANALYZE needs a prod-gate confirm and whether read-only
 * connections allow it. A SELECT … INTO, a data-modifying CTE and
 * locking reads (FOR UPDATE) count as writes.
 */
export function looksLikeWriteSql(sql: string): boolean {
  const s = sqlSkeleton(sql);
  const head = leadingKeyword(sql);
  if (!READ_HEADS.has(head)) return true;
  if (head === 'explain') return explainAnalyzes(s) && looksLikeWriteSql(explainTarget(s));
  if (/\b(insert|update|delete|merge|truncate)\b/.test(s) && head === 'with') return true;
  if (head === 'select' && /\binto\b/.test(s) && !/\binsert into\b/.test(s)) return true;
  if (/\bfor (update|no key update|share|key share)\b/.test(s)) return true;
  return false;
}

/**
 * Statements that cannot run inside a transaction block, or that manage
 * the transaction themselves — Transaction mode never auto-BEGINs these.
 */
export function isTxnExemptSql(sql: string): boolean {
  const s = sqlSkeleton(sql);
  const head = leadingKeyword(sql);
  if (
    [
      'begin',
      'start',
      'commit',
      'end',
      'rollback',
      'abort',
      'savepoint',
      'release',
      'prepare',
      'vacuum',
      'checkpoint',
      'discard',
      'listen',
      'unlisten',
    ].includes(head)
  ) {
    // PREPARE <name> AS … is an ordinary statement; PREPARE TRANSACTION is not.
    if (head === 'prepare') return /^prepare transaction\b/.test(s);
    return true;
  }
  if (/\bconcurrently\b/.test(s) && ['create', 'drop', 'reindex'].includes(head)) return true;
  if (/^(create|drop|alter) (database|tablespace|subscription)\b/.test(s)) return true;
  if (/^alter system\b/.test(s)) return true;
  if (head === 'reindex' && /^reindex (system|database)\b/.test(s)) return true;
  return false;
}
