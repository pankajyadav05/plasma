/**
 * Small, conservative DML parser for Safe Run.
 *
 * It does not understand SQL. It tokenizes (quotes, comments and dollar
 * quotes are opaque) and reads just enough of a single INSERT / UPDATE /
 * DELETE / MERGE to find the target table, its alias, the top-level WHERE
 * text and whether the statement already has a RETURNING clause.
 *
 * Anything it is not sure about (a leading WITH, several statements, a
 * FROM / USING list, WHERE CURRENT OF, unterminated quotes…) is reported
 * through `beforeSnapshot: false` plus a `reason`, and the caller falls
 * back to showing only the AFTER rows.
 */
import { splitSqlStatementRanges } from './sql-split';

export type DmlKind = 'insert' | 'update' | 'delete' | 'merge' | 'cte' | 'other';

export interface DmlTarget {
  /** Schema as written (may be quoted), when the name is qualified. */
  schema?: string;
  /** Table name as written (may be quoted). */
  table: string;
  /** `schema.table` exactly as the user wrote it; safe to splice back into SQL. */
  sql: string;
}

export interface DmlParse {
  kind: DmlKind;
  /** The statement without comments around it and without a trailing `;`. */
  sql: string;
  target?: DmlTarget;
  /** `ONLY` was written before the table name. */
  only: boolean;
  /** Alias as written (may be quoted). */
  alias?: string;
  /** Top-level WHERE text without the keyword (UPDATE / DELETE only). */
  where?: string;
  /** The statement already has a top-level RETURNING clause. */
  hasReturning: boolean;
  /** UPDATE … FROM, DELETE … USING or MERGE: other relations are involved. */
  multiTable: boolean;
  /**
   * A `SELECT … FROM <target> WHERE <same where>` taken before the
   * statement would list exactly the rows it changes (UPDATE / DELETE on
   * one plain table).
   */
  beforeSnapshot: boolean;
  /** Why `beforeSnapshot` is false or the parse is partial. */
  reason?: string;
}

type TokType = 'word' | 'qident' | 'string' | 'punct' | 'other';
interface Tok {
  type: TokType;
  /** Raw text. */
  text: string;
  /** Lower-cased text for words. */
  lower: string;
  start: number;
  end: number;
  depth: number;
}

const IDENT_CHAR = /[A-Za-z0-9_$\u0080-￿]/;
const IDENT_START = /[A-Za-z_\u0080-￿]/;
const DOLLAR_TAG = /\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/y;

/** Tokenize; returns null when a quote or comment never closes. */
function tokenize(sql: string): Tok[] | null {
  const toks: Tok[] = [];
  const N = sql.length;
  let i = 0;
  let depth = 0;
  const push = (type: TokType, start: number, end: number) => {
    const text = sql.slice(start, end);
    toks.push({
      type,
      text,
      lower: type === 'word' ? text.toLowerCase() : text,
      start,
      end,
      depth,
    });
  };
  while (i < N) {
    const c = sql[i]!;
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i + 2);
      i = nl === -1 ? N : nl + 1;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      let d = 1;
      i += 2;
      while (i < N && d > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          d++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          d--;
          i += 2;
        } else i++;
      }
      if (d > 0) return null;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const escapePrefix =
      (c === 'E' || c === 'e') && sql[i + 1] === "'" && (i === 0 || !IDENT_CHAR.test(sql[i - 1]!));
    if (c === "'" || escapePrefix) {
      const start = i;
      if (escapePrefix) i++;
      i++;
      let closed = false;
      while (i < N) {
        if (escapePrefix && sql[i] === '\\') i += i + 1 < N ? 2 : 1;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") {
          i++;
          closed = true;
          break;
        } else i++;
      }
      if (!closed) return null;
      push('string', start, i);
      continue;
    }
    if (c === '"') {
      const start = i;
      i++;
      let closed = false;
      while (i < N) {
        if (sql[i] === '"' && sql[i + 1] === '"') i += 2;
        else if (sql[i] === '"') {
          i++;
          closed = true;
          break;
        } else i++;
      }
      if (!closed) return null;
      push('qident', start, i);
      continue;
    }
    if (c === '$') {
      DOLLAR_TAG.lastIndex = i;
      const m = DOLLAR_TAG.exec(sql);
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        if (end === -1) return null;
        push('string', i, end + m[0].length);
        i = end + m[0].length;
        continue;
      }
      // $1 positional parameter.
      let j = i + 1;
      while (j < N && /[0-9]/.test(sql[j]!)) j++;
      push('other', i, Math.max(j, i + 1));
      i = Math.max(j, i + 1);
      continue;
    }
    if (c === '(') {
      push('punct', i, i + 1);
      depth++;
      i++;
      continue;
    }
    if (c === ')') {
      if (depth === 0) return null;
      depth--;
      push('punct', i, i + 1);
      i++;
      continue;
    }
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < N && IDENT_CHAR.test(sql[j]!)) j++;
      push('word', i, j);
      i = j;
      continue;
    }
    // Numbers and everything else, one char at a time (operators, dots, commas).
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < N && /[0-9A-Za-z_.]/.test(sql[j]!)) j++;
      push('other', i, j);
      i = j;
      continue;
    }
    push('punct', i, i + 1);
    i++;
  }
  return depth === 0 ? toks : null;
}

const isName = (t: Tok | undefined): t is Tok => t?.type === 'word' || t?.type === 'qident';
const isPunct = (t: Tok | undefined, ch: string): boolean => t?.type === 'punct' && t.text === ch;

/** Words that can follow a table name without being its alias. */
const NOT_ALIAS = new Set([
  'set',
  'using',
  'where',
  'returning',
  'values',
  'select',
  'default',
  'overriding',
  'on',
  'table',
  'with',
  'from',
]);

function empty(kind: DmlKind, sql: string, reason?: string): DmlParse {
  return {
    kind,
    sql,
    only: false,
    hasReturning: false,
    multiTable: false,
    beforeSnapshot: false,
    ...(reason ? { reason } : {}),
  };
}

/** Read `[schema.]table` at `i`; returns the target and the index after it. */
function readTarget(
  toks: Tok[],
  i: number,
  sql: string,
): { target: DmlTarget; next: number } | null {
  const first = toks[i];
  if (!isName(first)) return null;
  const parts = [first];
  let j = i + 1;
  while (isPunct(toks[j], '.') && isName(toks[j + 1]) && toks[j]!.start === toks[j - 1]!.end) {
    parts.push(toks[j + 1]!);
    j += 2;
  }
  // db.schema.table is a cross-database reference Postgres rejects anyway.
  if (parts.length > 2) return null;
  const last = parts[parts.length - 1]!;
  const target: DmlTarget = {
    table: last.text,
    sql: sql.slice(first.start, last.end),
    ...(parts.length === 2 ? { schema: parts[0]!.text } : {}),
  };
  return { target, next: j };
}

/** Top-level (depth 0) keyword positions from `from` on. */
function findTop(toks: Tok[], from: number, word: string): number {
  for (let i = from; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.depth === 0 && t.type === 'word' && t.lower === word) {
      // `IS DISTINCT FROM`, `EXTRACT(… FROM …)` (depth > 0 already).
      if (word === 'from' && toks[i - 1]?.lower === 'distinct') continue;
      return i;
    }
  }
  return -1;
}

/** Unquoted `*` after the table (descendant tables) is allowed and skipped. */
function skipStar(toks: Tok[], i: number): number {
  return isPunct(toks[i], '*') ? i + 1 : i;
}

/** Optional `[AS] alias`. Returns the alias and the next index. */
function readAlias(
  toks: Tok[],
  i: number,
  requireAs: boolean,
): { alias?: string; next: number } | null {
  const t = toks[i];
  if (!t) return { next: i };
  if (t.type === 'word' && t.lower === 'as') {
    const a = toks[i + 1];
    if (!isName(a)) return null;
    return { alias: a.text, next: i + 2 };
  }
  if (requireAs) return { next: i };
  if (t.type === 'qident') return { alias: t.text, next: i + 1 };
  if (t.type === 'word' && !NOT_ALIAS.has(t.lower)) return { alias: t.text, next: i + 1 };
  return { next: i };
}

/** Parse one statement. Never throws. */
export function parseDml(input: string): DmlParse {
  const ranges = splitSqlStatementRanges(input);
  if (ranges.length === 0) return empty('other', input.trim(), 'empty statement');
  if (ranges.length > 1) {
    return empty('other', input.trim(), 'more than one statement');
  }
  const sql = ranges[0]!.text;
  const toks = tokenize(sql);
  if (!toks || toks.length === 0) return empty('other', sql, 'could not tokenize the statement');
  const head = toks[0]!;
  if (head.type !== 'word') return empty('other', sql, 'not a data-changing statement');

  const keyword = head.lower;
  if (keyword === 'with') {
    return empty('cte', sql, 'WITH (common table expressions) are not analysed');
  }
  if (keyword !== 'insert' && keyword !== 'update' && keyword !== 'delete' && keyword !== 'merge') {
    return empty('other', sql, 'not an INSERT, UPDATE, DELETE or MERGE');
  }
  const kind = keyword as DmlKind;
  const out = empty(kind, sql);

  let i = 1;
  if (kind === 'insert' || kind === 'merge') {
    if (toks[i]?.lower !== 'into') return { ...out, reason: `expected INTO after ${keyword}` };
    i++;
  } else if (kind === 'delete') {
    if (toks[i]?.lower !== 'from') return { ...out, reason: 'expected FROM after DELETE' };
    i++;
  }
  if (kind !== 'insert' && toks[i]?.type === 'word' && toks[i]!.lower === 'only') {
    out.only = true;
    i++;
  }
  const read = readTarget(toks, i, sql);
  if (!read) return { ...out, reason: 'could not read the target table' };
  out.target = read.target;
  i = read.next;
  if (kind !== 'insert') i = skipStar(toks, i);

  const al = readAlias(toks, i, kind === 'insert');
  if (!al) return { ...out, reason: 'could not read the table alias' };
  if (al.alias) out.alias = al.alias;
  i = al.next;

  out.hasReturning = findTop(toks, i, 'returning') !== -1;

  if (kind === 'insert') {
    // The rows are whatever the statement inserts; nothing to snapshot first.
    return { ...out, reason: 'INSERT has no rows to capture before it runs' };
  }
  if (kind === 'merge') {
    return { ...out, multiTable: true, reason: 'MERGE reads a second relation' };
  }

  // UPDATE … SET … [FROM …] [WHERE …] / DELETE … [USING …] [WHERE …]
  if (kind === 'update' && toks[i]?.lower !== 'set') {
    return { ...out, reason: 'expected SET after the table name' };
  }
  const fromAt = kind === 'update' ? findTop(toks, i, 'from') : findTop(toks, i, 'using');
  const whereAt = findTop(toks, i, 'where');
  const retAt = findTop(toks, i, 'returning');
  if (fromAt !== -1) {
    out.multiTable = true;
    out.reason =
      kind === 'update' ? 'UPDATE … FROM joins other tables' : 'DELETE … USING joins other tables';
  }
  if (whereAt !== -1) {
    const endTok = retAt !== -1 && retAt > whereAt ? toks[retAt]!.start : sql.length;
    const where = sql.slice(toks[whereAt]!.end, endTok).trim();
    if (where.length === 0) return { ...out, reason: 'empty WHERE clause' };
    if (/^current\s+of\b/i.test(where)) {
      return { ...out, reason: 'WHERE CURRENT OF refers to a cursor' };
    }
    out.where = where;
  }
  out.beforeSnapshot = !out.multiTable;
  return out;
}

/** SELECT-able reference to the target inside the statement: alias, else the name as written. */
export function targetRef(p: DmlParse): string | undefined {
  return p.alias ?? p.target?.sql;
}

/**
 * `SELECT … FROM <target> WHERE <where>` that returns the rows an UPDATE /
 * DELETE is about to touch, row-locked so the picture cannot drift before
 * the statement runs. Includes `ctid` as `__plasma_ctid` when asked.
 * Returns null when `parseDml` could not vouch for the shape.
 */
export function buildBeforeSelect(p: DmlParse, opts?: { ctid?: boolean }): string | null {
  if (!p.beforeSnapshot || !p.target) return null;
  if (p.kind !== 'update' && p.kind !== 'delete') return null;
  const ref = targetRef(p)!;
  const cols = opts?.ctid ? `${ref}.ctid AS "__plasma_ctid", ${ref}.*` : `${ref}.*`;
  const from = `${p.only ? 'ONLY ' : ''}${p.target.sql}${p.alias ? ` AS ${p.alias}` : ''}`;
  return `SELECT ${cols} FROM ${from}${p.where ? ` WHERE ${p.where}` : ''} FOR UPDATE`;
}

/**
 * The statement with `RETURNING` for the AFTER rows, or null when it must
 * run as written (CTE / unparsed forms, or it already returns something,
 * or MERGE on a server older than 17).
 */
export function withReturning(
  p: DmlParse,
  opts?: { ctid?: boolean; serverVersionNum?: number },
): string | null {
  if (p.hasReturning || !p.target) return null;
  if (p.kind === 'merge' && (opts?.serverVersionNum ?? 0) < 170000) return null;
  if (p.kind !== 'insert' && p.kind !== 'update' && p.kind !== 'delete' && p.kind !== 'merge') {
    return null;
  }
  const ref = targetRef(p)!;
  const body = p.sql.replace(/\s*;\s*$/, '');
  // Single-table statements and INSERT can return `*`; joined forms must
  // pick the target's columns or the other relation's columns tag along.
  const qualify = p.kind === 'merge' || p.multiTable;
  const star = qualify ? `${ref}.*` : '*';
  const ctid = opts?.ctid ? `, ${qualify ? `${ref}.` : ''}ctid AS "__plasma_ctid"` : '';
  return `${body} RETURNING ${star}${ctid}`;
}
