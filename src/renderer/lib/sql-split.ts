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

/**
 * Find the statement under a cursor offset into `sql`.
 * - If the offset falls inside a statement's `[start, end]`, return it.
 * - If the offset is in a gap (whitespace / `;` between statements),
 *   return the following statement when one exists, else the previous.
 * - Empty buffer → undefined.
 */
/**
 * The statement "Run Current" means for a caret at `offset`: the last
 * statement that starts at or before the caret. So a caret just after a
 * `;`, at the end of a line, or on blank lines below a statement still
 * belongs to the statement the user just wrote — never the next one. A
 * caret above the first statement picks the first.
 */
export function statementAtOffset(sql: string, offset: number): SqlStatement | undefined {
  const stmts = splitSqlStatements(sql);
  if (stmts.length === 0) return undefined;
  const clamped = Math.max(0, Math.min(offset, sql.length));
  let hit = stmts[0];
  for (const s of stmts) {
    if (s.start <= clamped) hit = s;
    else break;
  }
  return hit;
}

/** 1-based position of the caret's statement, for "statement 2 of 3". */
export function statementPosition(
  sql: string,
  offset: number,
): { index: number; total: number; statement: SqlStatement } | null {
  const stmts = splitSqlStatements(sql);
  if (stmts.length === 0) return null;
  const clamped = Math.max(0, Math.min(offset, sql.length));
  let index = 0;
  for (let i = 0; i < stmts.length; i++) {
    if (stmts[i].start <= clamped) index = i;
    else break;
  }
  return { index: index + 1, total: stmts.length, statement: stmts[index] };
}

export interface EditorCaret {
  /** Cursor offset into the buffer (UTF-16 code units, Monaco-compatible). */
  cursorOffset: number;
  /** Selection range; empty when collapsed. */
  selectionStart: number;
  selectionEnd: number;
}

/**
 * - `smart`     — selection if any, else the statement at the caret (⌘⏎).
 * - `selection` — the selection only; nothing when it is empty.
 * - `current`   — the statement at the caret, ignoring any selection.
 * - `buffer`    — the whole editor (⌘⇧⏎).
 */
export type RunMode = 'smart' | 'selection' | 'current' | 'buffer';

export interface RunTarget {
  /** Script text to execute (may contain multiple statements). */
  sql: string;
  /**
   * Offset of `sql` within the full editor buffer. Statement offsets from
   * splitting `sql` are remapped by adding `base` for decorations/markers.
   */
  base: number;
}

/**
 * Resolve what a run command should execute. Without caret context (the
 * editor has never been focused) the caret is treated as the start of
 * the buffer — "Run Current" never silently widens to the whole script.
 */
export function resolveRunTarget(
  buffer: string,
  mode: RunMode,
  caret: EditorCaret | null,
): RunTarget | null {
  if (buffer.trim().length === 0) return null;
  if (mode === 'buffer') return { sql: buffer, base: 0 };

  const c = caret ?? { cursorOffset: 0, selectionStart: 0, selectionEnd: 0 };
  const selStart = Math.min(c.selectionStart, c.selectionEnd);
  const selEnd = Math.max(c.selectionStart, c.selectionEnd);
  const hasSelection = selEnd > selStart && buffer.slice(selStart, selEnd).trim().length > 0;

  if (mode === 'selection' || (mode === 'smart' && hasSelection)) {
    if (!hasSelection) return null;
    return { sql: buffer.slice(selStart, selEnd), base: selStart };
  }

  const stmt = statementAtOffset(buffer, c.cursorOffset);
  if (!stmt) return null;
  return { sql: stmt.text, base: stmt.start };
}
