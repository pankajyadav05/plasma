/**
 * The one Postgres statement splitter, shared by the renderer's
 * multi-statement runner (`@/lib/sql-split`) and the worker's AI
 * single-statement check (`@shared/sql-statements`).
 *
 * Handles:
 *   - Single quotes (`'...'`) with `''` escapes
 *   - Escape strings (`E'...'` / `e'...'`) with `\` escapes
 *   - Double-quoted identifiers (`"..."`) with `""` escapes
 *   - Dollar-quoted strings (`$$...$$`, `$tag$...$tag$`); a `$` inside an
 *     identifier (`a$b$c`) or a positional parameter (`$1`) is not a quote
 *   - Line comments (`-- …`) and nested block comments (`/* … *\/`)
 *   - SQL-standard function bodies (`BEGIN ATOMIC … END`, PG14+): inside
 *     `CREATE [OR REPLACE] FUNCTION|PROCEDURE`, `BEGIN` / `CASE` open a
 *     block and `END` closes one — the same heuristic psql uses — so the
 *     body's semicolons don't split the statement; the same goes for the
 *     `CREATE [TEMP] TRIGGER … BEGIN … END` bodies of SQLite and MySQL
 *
 * Chunks that hold only whitespace and comments are dropped (a trailing
 * `-- done` after the last `;` is not a statement). Linear time: dollar
 * tags are matched with a sticky regex instead of slicing the buffer.
 */

export interface SqlStatement {
  text: string;
  start: number;
  end: number;
}

const IDENT_CHAR = /[A-Za-z0-9_$\u0080-￿]/;
const IDENT_START = /[A-Za-z_\u0080-￿]/;
const DOLLAR_TAG = /\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/y;

export function splitSqlStatementRanges(sql: string): SqlStatement[] {
  const out: SqlStatement[] = [];
  const N = sql.length;
  let i = 0;
  let start = 0;
  // Per-statement state.
  let hasCode = false;
  let parenDepth = 0;
  let beginDepth = 0;
  // First identifiers of the statement, lower-cased (psql's heuristic).
  let idents: string[] = [];

  const resetStatement = () => {
    hasCode = false;
    parenDepth = 0;
    beginDepth = 0;
    idents = [];
  };

  const pushSlice = (from: number, to: number) => {
    if (!hasCode) return;
    const piece = sql.slice(from, to);
    const lead = piece.length - piece.trimStart().length;
    const trail = piece.length - piece.trimEnd().length;
    const s = from + lead;
    const e = to - trail;
    if (e > s) out.push({ text: sql.slice(s, e), start: s, end: e });
  };

  const inRoutineDefinition = () => {
    if (idents[0] !== 'create') return false;
    if (idents[1] === 'function' || idents[1] === 'procedure') return true;
    // SQLite / MySQL: CREATE [TEMP] TRIGGER … BEGIN stmt; stmt; END.
    if (idents[1] === 'trigger') return true;
    if ((idents[1] === 'temp' || idents[1] === 'temporary') && idents[2] === 'trigger') return true;
    return (
      idents[1] === 'or' &&
      idents[2] === 'replace' &&
      (idents[3] === 'function' || idents[3] === 'procedure')
    );
  };

  while (i < N) {
    const c = sql[i]!;

    // Line comment.
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i + 2);
      i = nl === -1 ? N : nl + 1;
      continue;
    }

    // Block comment (nesting allowed).
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
        } else {
          i++;
        }
      }
      continue;
    }

    if (c === ';') {
      // psql keeps a paren depth too: `CREATE RULE … DO ALSO (INSERT …; INSERT …)`
      // is one statement.
      if (beginDepth === 0 && parenDepth === 0) {
        pushSlice(start, i);
        start = i + 1;
        resetStatement();
      }
      i++;
      continue;
    }

    if (/\s/.test(c)) {
      i++;
      continue;
    }

    hasCode = true;

    // String literal, optionally E-prefixed (E must start a token).
    const escapePrefix =
      (c === 'E' || c === 'e') && sql[i + 1] === "'" && (i === 0 || !IDENT_CHAR.test(sql[i - 1]!));
    if (c === "'" || escapePrefix) {
      if (escapePrefix) i++;
      i++;
      while (i < N) {
        if (escapePrefix && sql[i] === '\\') {
          i += i + 1 < N ? 2 : 1;
        } else if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
        } else if (sql[i] === "'") {
          i++;
          break;
        } else {
          i++;
        }
      }
      continue;
    }

    // Quoted identifier.
    if (c === '"') {
      i++;
      while (i < N) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          i += 2;
        } else if (sql[i] === '"') {
          i++;
          break;
        } else {
          i++;
        }
      }
      continue;
    }

    // MySQL / SQLite backtick identifier (not valid Postgres, so never ambiguous).
    if (c === '`') {
      i++;
      while (i < N) {
        if (sql[i] === '`' && sql[i + 1] === '`') {
          i += 2;
        } else if (sql[i] === '`') {
          i++;
          break;
        } else {
          i++;
        }
      }
      continue;
    }

    // Dollar quote (never inside an identifier: `a$b$c`).
    if (c === '$') {
      DOLLAR_TAG.lastIndex = i;
      const m = DOLLAR_TAG.exec(sql);
      if (m) {
        const closer = m[0];
        const end = sql.indexOf(closer, i + closer.length);
        i = end === -1 ? N : end + closer.length;
        continue;
      }
      i++;
      continue;
    }

    if (c === '(') {
      parenDepth++;
      i++;
      continue;
    }
    if (c === ')') {
      if (parenDepth > 0) parenDepth--;
      i++;
      continue;
    }

    // Identifier / keyword.
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < N && IDENT_CHAR.test(sql[j]!)) j++;
      const word = sql.slice(i, j).toLowerCase();
      if (idents.length < 4) idents.push(word);
      if (parenDepth === 0 && inRoutineDefinition()) {
        if (word === 'begin') beginDepth++;
        else if (word === 'case' && beginDepth > 0) beginDepth++;
        else if (word === 'end' && beginDepth > 0) beginDepth--;
      }
      i = j;
      continue;
    }

    i++;
  }

  pushSlice(start, N);
  return out;
}

/**
 * Why a statement can't run through Plasma's query path, or null. psql
 * meta-commands and COPY … FROM STDIN need a client-side protocol that a
 * plain query can't provide; name the problem instead of letting the
 * server return a confusing syntax error or hang waiting for data.
 */
export function unsupportedStatementReason(text: string): string | null {
  const t = text.replace(/^(\s|--[^\n]*\n?|\/\*[\s\S]*?\*\/)*/, '');
  if (t.startsWith('\\')) {
    return 'psql meta-commands (\\d, \\copy, …) are not SQL — Plasma runs SQL only';
  }
  if (/^copy\b[\s\S]*\bfrom\s+stdin\b/i.test(t)) {
    return 'COPY … FROM STDIN needs a client data stream — use Import or INSERT instead';
  }
  if (/^copy\b[\s\S]*\bto\s+stdout\b/i.test(t)) {
    return 'COPY … TO STDOUT needs a client data stream — run the SELECT and use Export instead';
  }
  return null;
}
