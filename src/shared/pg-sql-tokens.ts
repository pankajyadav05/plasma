/**
 * A small, conservative Postgres tokenizer for DDL analysis (the migration
 * linter and the lock preview). It is NOT a parser: it only needs to find
 * keywords, qualified names and parenthesis structure inside one statement
 * that `splitSqlStatementRanges` already isolated. Comments are dropped,
 * string / dollar-quoted bodies collapse into a single `string` token, and
 * every token keeps its offsets in the source so quick fixes can edit it.
 */

export type TokenKind = 'word' | 'quoted' | 'string' | 'number' | 'punct';

export interface Token {
  kind: TokenKind;
  /** Source text (quotes included for `quoted` / `string`). */
  text: string;
  /** Lower-cased for words; the unquoted identifier for `quoted`; text otherwise. */
  value: string;
  start: number;
  end: number;
}

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_CHAR = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR_TAG = /\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/y;

export function tokenizeSql(sql: string, offset = 0): Token[] {
  const out: Token[] = [];
  const N = sql.length;
  let i = 0;
  const push = (kind: TokenKind, from: number, to: number, value?: string) => {
    const text = sql.slice(from, to);
    out.push({
      kind,
      text,
      value: value ?? (kind === 'word' ? text.toLowerCase() : text),
      start: from + offset,
      end: to + offset,
    });
  };
  while (i < N) {
    const c = sql[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i + 2);
      i = nl === -1 ? N : nl + 1;
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
      continue;
    }
    // Escape string E'...' (backslash escapes) — before the word rule.
    if ((c === 'E' || c === 'e') && sql[i + 1] === "'") {
      const from = i;
      i += 2;
      while (i < N) {
        if (sql[i] === '\\') i += 2;
        else if (sql[i] === "'") {
          if (sql[i + 1] === "'") i += 2;
          else {
            i++;
            break;
          }
        } else i++;
      }
      push('string', from, Math.min(i, N));
      continue;
    }
    if (c === "'") {
      const from = i;
      i++;
      while (i < N) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") i += 2;
          else {
            i++;
            break;
          }
        } else i++;
      }
      push('string', from, i);
      continue;
    }
    if (c === '"') {
      const from = i;
      i++;
      let ident = '';
      while (i < N) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            ident += '"';
            i += 2;
          } else {
            i++;
            break;
          }
        } else ident += sql[i++];
      }
      push('quoted', from, i, ident);
      continue;
    }
    if (c === '$') {
      DOLLAR_TAG.lastIndex = i;
      const m = DOLLAR_TAG.exec(sql);
      if (m) {
        const close = sql.indexOf(m[0], i + m[0].length);
        const to = close === -1 ? N : close + m[0].length;
        push('string', i, to);
        i = to;
        continue;
      }
      // $1 positional parameter
      let j = i + 1;
      while (j < N && /[0-9]/.test(sql[j]!)) j++;
      push('word', i, Math.max(j, i + 1));
      i = Math.max(j, i + 1);
      continue;
    }
    if (WORD_START.test(c)) {
      let j = i + 1;
      while (j < N && WORD_CHAR.test(sql[j]!)) j++;
      push('word', i, j);
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < N && /[0-9._eE]/.test(sql[j]!)) j++;
      push('number', i, j);
      i = j;
      continue;
    }
    // `::` as a single punct token keeps cast detection simple.
    if (c === ':' && sql[i + 1] === ':') {
      push('punct', i, i + 2);
      i += 2;
      continue;
    }
    push('punct', i, i + 1);
    i++;
  }
  return out;
}

export function isWord(t: Token | undefined, ...words: string[]): boolean {
  return !!t && t.kind === 'word' && (words.length === 0 || words.includes(t.value));
}

export function isPunct(t: Token | undefined, p: string): boolean {
  return !!t && t.kind === 'punct' && t.text === p;
}

export interface QualifiedName {
  schema: string | null;
  name: string;
  /** Source form (`public.orders`, `"My Tbl"`), safe to hand to `to_regclass`. */
  raw: string;
  /** Display form, `schema.name` when qualified. */
  display: string;
  /** Lower-cased lookup key; unquoted parts are folded, quoted parts kept. */
  key: string;
}

function identPart(t: Token): string {
  return t.kind === 'quoted' ? t.value : t.value.toLowerCase();
}

/** Parse `a`, `a.b` or `a.b.c` (catalog prefix ignored) starting at `i`. */
export function parseQualifiedName(
  tokens: Token[],
  i: number,
): { name: QualifiedName; next: number } | null {
  const first = tokens[i];
  if (!first || (first.kind !== 'word' && first.kind !== 'quoted')) return null;
  const parts: Token[] = [first];
  let j = i + 1;
  while (
    isPunct(tokens[j], '.') &&
    (tokens[j + 1]?.kind === 'word' || tokens[j + 1]?.kind === 'quoted')
  ) {
    parts.push(tokens[j + 1]!);
    j += 2;
  }
  const last = parts[parts.length - 1]!;
  const schemaTok = parts.length >= 2 ? parts[parts.length - 2]! : null;
  const name = identPart(last);
  const schema = schemaTok ? identPart(schemaTok) : null;
  return {
    name: {
      schema,
      name,
      raw: schemaTok ? `${schemaTok.text}.${last.text}` : last.text,
      display: schema ? `${schema}.${name}` : name,
      key: schema ? `${schema}.${name}` : name,
    },
    next: j,
  };
}

/** Index of the matching `)` for the `(` at `open` (or tokens.length). */
export function matchParen(tokens: Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (isPunct(tokens[i], '(')) depth++;
    else if (isPunct(tokens[i], ')')) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return tokens.length;
}

/** Split `tokens` on depth-0 commas. Returned slices keep their tokens. */
export function splitTopLevelCommas(tokens: Token[]): Token[][] {
  const out: Token[][] = [];
  let depth = 0;
  let cur: Token[] = [];
  for (const t of tokens) {
    if (isPunct(t, '(')) depth++;
    else if (isPunct(t, ')')) depth--;
    if (depth === 0 && isPunct(t, ',')) {
      out.push(cur);
      cur = [];
    } else cur.push(t);
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** Column names inside a parenthesised list at `open`, e.g. `(a, "B")`. */
export function parseColumnList(tokens: Token[], open: number): { cols: string[]; next: number } {
  const close = matchParen(tokens, open);
  const cols: string[] = [];
  for (const group of splitTopLevelCommas(tokens.slice(open + 1, close))) {
    const t = group[0];
    if (!t) continue;
    // `lower(email)` / `(a + b)` are expressions, not plain columns.
    if ((t.kind === 'word' || t.kind === 'quoted') && !isPunct(group[1], '('))
      cols.push(identPart(t));
    else cols.push('(expr)');
  }
  return { cols, next: close + 1 };
}
