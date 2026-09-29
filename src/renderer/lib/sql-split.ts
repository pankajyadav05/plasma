import { type SqlStatement, splitSqlStatementRanges } from '@shared/sql-split';

export type { SqlStatement } from '@shared/sql-split';
export { unsupportedStatementReason } from '@shared/sql-split';

/**
 * Split a SQL buffer into statements with offsets into the original
 * string. Offsets feed run-selection / statement-at-cursor (U24) and
 * error markers. The tokenizer lives in `@shared/sql-split` so the
 * renderer and the worker can never disagree on statement boundaries.
 */
export function splitSqlStatements(sql: string): SqlStatement[] {
  return splitSqlStatementRanges(sql);
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
