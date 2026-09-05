/**
 * One statement extracted from a multi-statement SQL buffer, with
 * offsets into the original string (trimmed content range). Offsets
 * feed run-selection / statement-at-cursor (U24) and error markers.
 */
export interface SqlStatement {
  text: string;
  start: number;
  end: number;
}

/**
 * Split a SQL string into statements, respecting Postgres quoting and
 * comments. Used by the multi-statement runner so a tab containing
 * `INSERT …; UPDATE …; SELECT …` runs each statement in order, stops
 * on the first error, and reports per-statement progress.
 *
 * Handles:
 *   - Single quotes (`'...'`) with `''` escapes
 *   - PostgreSQL escape strings (`E'...'` / `e'...'`) with `\` escapes
 *   - Double-quoted identifiers (`"..."`) with `""` escapes
 *   - Dollar-quoted strings (`$$...$$`, `$tag$...$tag$`) — required for
 *     function bodies and PL/pgSQL DO blocks
 *   - Line comments (`-- …\n`)
 *   - Block comments (`/* … *\/`) — Postgres allows these to nest
 *
 * Returns trimmed, non-empty statements (without trailing `;`), each
 * with `{ text, start, end }` offsets into the original buffer.
 */
export function splitSqlStatements(sql: string): SqlStatement[] {
  const out: SqlStatement[] = [];
  let i = 0;
  let start = 0;
  const N = sql.length;

  const pushSlice = (from: number, to: number) => {
    const piece = sql.slice(from, to);
    const trimmed = piece.trim();
    if (trimmed.length === 0) return;
    const lead = piece.length - piece.trimStart().length;
    const trail = piece.length - piece.trimEnd().length;
    const s = from + lead;
    const e = to - trail;
    out.push({ text: sql.slice(s, e), start: s, end: e });
  };

  while (i < N) {
    const c = sql[i];

    // Line comment — runs to end of line.
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i + 2);
      i = nl === -1 ? N : nl + 1;
      continue;
    }

    // Block comment — Postgres allows nesting, track depth.
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

    // Escape-string literal: E'...' / e'...' with backslash escapes.
    // Standard string: '...' with '' escapes. Detect E' only when E/e
    // is immediately followed by a quote (Postgres lexer token).
    // E/e must be a standalone token start — not the tail of an
    // identifier like `UE'...'`.
    const escapePrefix =
      (c === 'E' || c === 'e') &&
      sql[i + 1] === "'" &&
      (i === 0 || !/[A-Za-z0-9_$]/.test(sql[i - 1]!));
    if (c === "'" || escapePrefix) {
      if (escapePrefix) i++; // skip E/e
      i++; // skip opening quote
      while (i < N) {
        if (escapePrefix && sql[i] === '\\') {
          // Consume backslash + following char (\' \\ \n \xHH …).
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

    // Double-quoted identifier (with "" escapes).
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

    // Dollar-quoted string. The opening tag is `$<ident?>$`. We capture
    // the tag (possibly empty) and scan for the matching closer.
    if (c === '$') {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tagMatch) {
        const closer = tagMatch[0];
        const after = i + closer.length;
        const end = sql.indexOf(closer, after);
        if (end === -1) {
          // Unterminated — treat the rest as part of the current statement.
          i = N;
        } else {
          i = end + closer.length;
        }
        continue;
      }
    }

    if (c === ';') {
      pushSlice(start, i);
      start = i + 1;
      i++;
      continue;
    }

    i++;
  }

  pushSlice(start, N);
  return out;
}
