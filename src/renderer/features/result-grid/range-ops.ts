/**
 * Bulk-edit planning for the result grid (pure): set a value over a range,
 * fill down, paste a spreadsheet block and find & replace. Each planner
 * returns *writes* — `{ row, col, value }` in display-row / original
 * column coordinates, with `value` as Postgres text (null = SQL NULL) — and
 * the grid stages them as ordinary pending edits. Nothing here touches the
 * store, so every rule is unit-testable.
 */

/** A cell in the grid: `row` is the display row, `col` the ORIGINAL column index. */
export interface GridCell {
  row: number;
  col: number;
}

export interface CellWrite extends GridCell {
  value: string | null;
}

/** Selection rectangle: display rows `r0..r1`, visible-column positions `p0..p1`. */
export interface GridRange {
  r0: number;
  r1: number;
  p0: number;
  p1: number;
}

/** Range from an anchor + far corner, in visible-column positions. */
export function rangeOf(
  anchor: { row: number; pos: number },
  end: { row: number; pos: number },
): GridRange {
  return {
    r0: Math.min(anchor.row, end.row),
    r1: Math.max(anchor.row, end.row),
    p0: Math.min(anchor.pos, end.pos),
    p1: Math.max(anchor.pos, end.pos),
  };
}

/** Every cell of a range, row-major. `visibleCols[p]` = original column index at position p. */
export function rangeCells(range: GridRange, visibleCols: readonly number[]): GridCell[] {
  const out: GridCell[] = [];
  for (let r = range.r0; r <= range.r1; r++) {
    for (let p = range.p0; p <= range.p1; p++) {
      const col = visibleCols[p];
      if (col !== undefined) out.push({ row: r, col });
    }
  }
  return out;
}

/** Original column indices spanned by a range, left to right. */
export function rangeColumns(range: GridRange, visibleCols: readonly number[]): number[] {
  return visibleCols.slice(range.p0, range.p1 + 1);
}

/** Clamp a range to the loaded rows / visible columns. */
export function clampRange(
  range: GridRange,
  rowCount: number,
  colCount: number,
): { range: GridRange | null; clamped: boolean } {
  if (rowCount <= 0 || colCount <= 0) return { range: null, clamped: true };
  const next: GridRange = {
    r0: Math.max(0, range.r0),
    r1: Math.min(rowCount - 1, range.r1),
    p0: Math.max(0, range.p0),
    p1: Math.min(colCount - 1, range.p1),
  };
  const clamped =
    next.r0 !== range.r0 || next.r1 !== range.r1 || next.p0 !== range.p0 || next.p1 !== range.p1;
  if (next.r0 > next.r1 || next.p0 > next.p1) return { range: null, clamped: true };
  return { range: next, clamped };
}

// ─── Set value ───────────────────────────────────────────────────────

export function planSetValue(cells: readonly GridCell[], value: string | null): CellWrite[] {
  return cells.map((c) => ({ row: c.row, col: c.col, value }));
}

// ─── Fill down ───────────────────────────────────────────────────────

export interface FillDownPlan {
  writes: CellWrite[];
  /** Why nothing happened (a single-row range has nothing to fill). */
  note?: string;
}

/**
 * Copy the first row of the range into every row below it, per column.
 * `textAt` is the current (pending-aware) Postgres text of a cell;
 * `undefined` (a DEFAULT on a new row) is not propagated.
 */
export function planFillDown(
  range: GridRange,
  visibleCols: readonly number[],
  textAt: (row: number, col: number) => string | null | undefined,
): FillDownPlan {
  if (range.r1 <= range.r0) {
    return { writes: [], note: 'Select two or more rows to fill down.' };
  }
  const writes: CellWrite[] = [];
  for (const col of rangeColumns(range, visibleCols)) {
    const source = textAt(range.r0, col);
    if (source === undefined) continue;
    for (let r = range.r0 + 1; r <= range.r1; r++) writes.push({ row: r, col, value: source });
  }
  return { writes };
}

// ─── Paste ───────────────────────────────────────────────────────────

const TEXT_TYPES = new Set([
  'text',
  'varchar',
  'character varying',
  'bpchar',
  'char',
  'character',
  'name',
  'citext',
  'unknown',
]);

function baseType(typeName: string | null | undefined): string {
  return (typeName ?? '')
    .replace(/\(.*\)/, '')
    .trim()
    .toLowerCase();
}

/** Types where an empty string is a legitimate value (everything else treats '' as blank). */
export function isTextLikeType(typeName: string | null | undefined): boolean {
  return TEXT_TYPES.has(baseType(typeName));
}

export interface PastePlan {
  /** Writes onto existing (loaded) rows. */
  writes: CellWrite[];
  /** Block rows past the last loaded row, as column index → value. */
  overflow: Array<Record<number, string | null>>;
  /** Pasted columns that fell off the right edge. */
  clippedColumns: number;
  /** True when a single value was spread over a multi-cell range. */
  filledRange: boolean;
}

export interface PasteInput {
  block: ReadonlyArray<ReadonlyArray<string | null>>;
  anchor: { row: number; pos: number };
  /** Selected range, when more than one cell is selected. */
  range?: GridRange | null;
  visibleCols: readonly number[];
  /** Number of loaded display rows. */
  rowCount: number;
  typeOf: (col: number) => string | undefined;
}

/**
 * Plan pasting a spreadsheet block. A single value fills the whole range;
 * otherwise the block is laid out from the anchor. Spreadsheet blanks are
 * NULL for non-text columns (an empty string would fail the cast), rows
 * past the last loaded row become `overflow` (offered as inserts), and
 * columns past the last visible one are counted in `clippedColumns`.
 */
export function planPaste(input: PasteInput): PastePlan {
  const { block, anchor, range, visibleCols, rowCount, typeOf } = input;
  const norm = (col: number, v: string | null): string | null =>
    v === '' && !isTextLikeType(typeOf(col)) ? null : v;
  const empty: PastePlan = { writes: [], overflow: [], clippedColumns: 0, filledRange: false };
  if (block.length === 0) return empty;

  const single = block.length === 1 && block[0]?.length === 1;
  if (single && range && (range.r1 > range.r0 || range.p1 > range.p0)) {
    const v = block[0]?.[0] ?? null;
    const writes = rangeCells(range, visibleCols)
      .filter((c) => c.row < rowCount)
      .map((c) => ({ row: c.row, col: c.col, value: norm(c.col, v) }));
    return { ...empty, writes, filledRange: true };
  }

  const writes: CellWrite[] = [];
  const overflow: Array<Record<number, string | null>> = [];
  let clipped = 0;
  for (let r = 0; r < block.length; r++) {
    const values = block[r] ?? [];
    const rowIdx = anchor.row + r;
    const extra: Record<number, string | null> = {};
    for (let c = 0; c < values.length; c++) {
      const col = visibleCols[anchor.pos + c];
      if (col === undefined) {
        clipped = Math.max(clipped, values.length - c);
        break;
      }
      const v = norm(col, values[c] ?? null);
      if (rowIdx < rowCount) writes.push({ row: rowIdx, col, value: v });
      else extra[col] = v;
    }
    if (rowIdx >= rowCount && Object.keys(extra).length > 0) overflow.push(extra);
  }
  return { writes, overflow, clippedColumns: clipped, filledRange: false };
}

/** Human note about what a paste did not (directly) apply. */
export function describePasteNotes(plan: PastePlan, appliedOverflow: boolean): string | null {
  const notes: string[] = [];
  if (plan.clippedColumns > 0) {
    notes.push(
      `${plan.clippedColumns} pasted column${plan.clippedColumns === 1 ? '' : 's'} did not fit and ${plan.clippedColumns === 1 ? 'was' : 'were'} ignored`,
    );
  }
  if (plan.overflow.length > 0 && !appliedOverflow) {
    notes.push(
      `${plan.overflow.length} row${plan.overflow.length === 1 ? '' : 's'} past the last loaded row ${plan.overflow.length === 1 ? 'was' : 'were'} not pasted`,
    );
  }
  return notes.length > 0 ? `${notes.join('; ')}.` : null;
}

// ─── Find & replace ──────────────────────────────────────────────────

export interface FindReplaceOptions {
  find: string;
  replace: string;
  caseSensitive: boolean;
  regex: boolean;
  /** Match only when the whole cell equals the pattern. */
  wholeCell?: boolean;
}

export interface FindCell extends GridCell {
  /** Current Postgres text (null = NULL, undefined = DEFAULT): those are never matched. */
  text: string | null | undefined;
}

export interface FindReplacePlan {
  writes: CellWrite[];
  /** Cells that will change. */
  cellCount: number;
  /** Individual replacements across those cells. */
  occurrences: number;
  /** Invalid regex / empty pattern. */
  error?: string;
}

/** Compile the search pattern; returns an error message instead of throwing. */
export function compileFindPattern(
  opts: Pick<FindReplaceOptions, 'find' | 'caseSensitive' | 'regex' | 'wholeCell'>,
): { re: RegExp } | { error: string } {
  if (opts.find === '') return { error: 'Enter text to find.' };
  let source = opts.regex ? opts.find : opts.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (opts.wholeCell) source = `^(?:${source})$`;
  try {
    return { re: new RegExp(source, opts.caseSensitive ? 'g' : 'gi') };
  } catch (err) {
    return {
      error: `Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Plan a find & replace over `cells`. In literal mode the replacement is
 * inserted verbatim (`$&` means `$&`); in regex mode `$1`, `$&` … work.
 * Cells whose text would not change are not staged.
 */
export function planFindReplace(
  cells: readonly FindCell[],
  opts: FindReplaceOptions,
): FindReplacePlan {
  const compiled = compileFindPattern(opts);
  if ('error' in compiled)
    return { writes: [], cellCount: 0, occurrences: 0, error: compiled.error };
  const { re } = compiled;
  const writes: CellWrite[] = [];
  let occurrences = 0;
  for (const cell of cells) {
    if (typeof cell.text !== 'string') continue;
    if (cell.text === '' && !opts.regex) continue;
    const n = [...cell.text.matchAll(re)].length;
    if (n === 0) continue;
    // Literal mode inserts the replacement verbatim (a function result is
    // never $-expanded); regex mode lets $1 / $& / $<name> expand.
    const next = opts.regex
      ? cell.text.replace(re, opts.replace)
      : cell.text.replace(re, () => opts.replace);
    if (next === cell.text) continue;
    occurrences += n;
    writes.push({ row: cell.row, col: cell.col, value: next });
  }
  return { writes, cellCount: writes.length, occurrences };
}

/** "3 cells (5 occurrences)" style preview label. */
export function describeFindPlan(plan: FindReplacePlan): string {
  if (plan.error) return plan.error;
  if (plan.cellCount === 0) return 'No matches.';
  const cells = `${plan.cellCount.toLocaleString('en-US')} cell${plan.cellCount === 1 ? '' : 's'}`;
  return plan.occurrences === plan.cellCount
    ? `${cells} will change.`
    : `${cells} will change (${plan.occurrences.toLocaleString('en-US')} replacements).`;
}

// ─── Clamping note ───────────────────────────────────────────────────

/** Note shown when a bulk edit only covers the rows loaded in the grid. */
export function loadedRowsNote(loaded: number, total: number | null | undefined): string | null {
  if (total === null || total === undefined || total <= loaded) return null;
  return `Only the ${loaded.toLocaleString('en-US')} loaded rows were changed — the table has ${total.toLocaleString('en-US')}.`;
}

/** One-line result of a bulk edit ("Staged 12 edits · 2 rows skipped (marked for deletion)"). */
export function describeBulkResult(input: {
  verb: string;
  staged: number;
  unchanged: number;
  skipped: number;
  loadedNote?: string | null;
}): string {
  const { verb, staged, unchanged, skipped, loadedNote } = input;
  const parts: string[] = [];
  if (staged === 0) {
    parts.push(
      unchanged > 0
        ? 'Nothing to change — the cells already hold that value'
        : 'Nothing was staged',
    );
  } else {
    parts.push(`${verb}: ${staged.toLocaleString('en-US')} cell${staged === 1 ? '' : 's'} staged`);
  }
  if (staged > 0 && unchanged > 0)
    parts.push(`${unchanged.toLocaleString('en-US')} already matched`);
  if (skipped > 0) {
    parts.push(
      `${skipped.toLocaleString('en-US')} skipped (rows marked for deletion or not loaded)`,
    );
  }
  const base = `${parts.join(' · ')}.`;
  return loadedNote ? `${base} ${loadedNote}` : base;
}
