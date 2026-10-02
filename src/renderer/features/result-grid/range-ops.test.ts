import { describe, expect, it } from 'vitest';
import {
  clampRange,
  compileFindPattern,
  describeBulkResult,
  describeFindPlan,
  describePasteNotes,
  isTextLikeType,
  loadedRowsNote,
  planFillDown,
  planFindReplace,
  planPaste,
  planSetValue,
  rangeCells,
  rangeColumns,
  rangeOf,
} from './range-ops';

// Visible columns: positions 0..3 map to original columns 0,1,3,4 (col 2 hidden).
const VIS = [0, 1, 3, 4];

describe('ranges', () => {
  it('normalises any drag direction', () => {
    expect(rangeOf({ row: 4, pos: 3 }, { row: 1, pos: 1 })).toEqual({ r0: 1, r1: 4, p0: 1, p1: 3 });
  });
  it('lists cells row-major in original column indices, skipping hidden columns', () => {
    const cells = rangeCells({ r0: 0, r1: 1, p0: 1, p1: 2 }, VIS);
    expect(cells).toEqual([
      { row: 0, col: 1 },
      { row: 0, col: 3 },
      { row: 1, col: 1 },
      { row: 1, col: 3 },
    ]);
    expect(rangeColumns({ r0: 0, r1: 0, p0: 1, p1: 3 }, VIS)).toEqual([1, 3, 4]);
  });
  it('clamps to loaded rows and columns and reports it', () => {
    expect(clampRange({ r0: 2, r1: 99, p0: 0, p1: 9 }, 10, 4)).toEqual({
      range: { r0: 2, r1: 9, p0: 0, p1: 3 },
      clamped: true,
    });
    expect(clampRange({ r0: 0, r1: 1, p0: 0, p1: 1 }, 10, 4).clamped).toBe(false);
    expect(clampRange({ r0: 12, r1: 15, p0: 0, p1: 1 }, 10, 4)).toEqual({
      range: null,
      clamped: true,
    });
    expect(clampRange({ r0: 0, r1: 1, p0: 0, p1: 1 }, 0, 4).range).toBeNull();
  });
});

describe('planSetValue', () => {
  it('writes one value (or NULL) to every cell', () => {
    const cells = rangeCells({ r0: 0, r1: 1, p0: 0, p1: 0 }, VIS);
    expect(planSetValue(cells, 'x')).toEqual([
      { row: 0, col: 0, value: 'x' },
      { row: 1, col: 0, value: 'x' },
    ]);
    expect(planSetValue(cells, null).every((w) => w.value === null)).toBe(true);
  });
});

describe('planFillDown', () => {
  const grid: Record<string, string | null | undefined> = {
    '0:0': 'a',
    '0:1': null,
    '0:3': undefined,
  };
  const textAt = (r: number, c: number) => grid[`${r}:${c}`];
  it('copies the top row down each column', () => {
    const plan = planFillDown({ r0: 0, r1: 2, p0: 0, p1: 1 }, VIS, textAt);
    expect(plan.writes).toEqual([
      { row: 1, col: 0, value: 'a' },
      { row: 2, col: 0, value: 'a' },
      { row: 1, col: 1, value: null },
      { row: 2, col: 1, value: null },
    ]);
  });
  it('does not propagate DEFAULT placeholders', () => {
    expect(planFillDown({ r0: 0, r1: 1, p0: 2, p1: 2 }, VIS, textAt).writes).toEqual([]);
  });
  it('explains a single-row selection', () => {
    const plan = planFillDown({ r0: 3, r1: 3, p0: 0, p1: 1 }, VIS, textAt);
    expect(plan.writes).toEqual([]);
    expect(plan.note).toMatch(/two or more rows/);
  });
});

describe('planPaste', () => {
  const typeOf = (c: number) => (c === 1 ? 'int4' : 'text');
  it('lays a block out from the anchor', () => {
    const plan = planPaste({
      block: [
        ['a', '1'],
        ['b', '2'],
      ],
      anchor: { row: 0, pos: 0 },
      visibleCols: VIS,
      rowCount: 5,
      typeOf,
    });
    expect(plan.writes).toEqual([
      { row: 0, col: 0, value: 'a' },
      { row: 0, col: 1, value: '1' },
      { row: 1, col: 0, value: 'b' },
      { row: 1, col: 1, value: '2' },
    ]);
    expect(plan.overflow).toEqual([]);
  });
  it('turns spreadsheet blanks into NULL for non-text columns only', () => {
    const plan = planPaste({
      block: [['', '']],
      anchor: { row: 0, pos: 0 },
      visibleCols: VIS,
      rowCount: 1,
      typeOf,
    });
    expect(plan.writes).toEqual([
      { row: 0, col: 0, value: '' },
      { row: 0, col: 1, value: null },
    ]);
  });
  it('separates rows past the last loaded row as overflow', () => {
    const plan = planPaste({
      block: [['a'], ['b'], ['c']],
      anchor: { row: 3, pos: 0 },
      visibleCols: VIS,
      rowCount: 4,
      typeOf,
    });
    expect(plan.writes).toEqual([{ row: 3, col: 0, value: 'a' }]);
    expect(plan.overflow).toEqual([{ 0: 'b' }, { 0: 'c' }]);
    expect(describePasteNotes(plan, false)).toMatch(
      /2 rows past the last loaded row were not pasted/,
    );
    expect(describePasteNotes(plan, true)).toBeNull();
  });
  it('clips columns beyond the last visible one and says so', () => {
    const plan = planPaste({
      block: [['a', '1', 'x', 'y', 'z']],
      anchor: { row: 0, pos: 2 },
      visibleCols: VIS,
      rowCount: 1,
      typeOf,
    });
    expect(plan.writes.map((w) => w.col)).toEqual([3, 4]);
    expect(plan.clippedColumns).toBe(3);
    expect(describePasteNotes(plan, false)).toMatch(/3 pasted columns did not fit/);
  });
  it('fills a multi-cell range with a single pasted value, clamped to loaded rows', () => {
    const plan = planPaste({
      block: [['7']],
      anchor: { row: 0, pos: 1 },
      range: { r0: 0, r1: 3, p0: 1, p1: 1 },
      visibleCols: VIS,
      rowCount: 2,
      typeOf,
    });
    expect(plan.filledRange).toBe(true);
    expect(plan.writes).toEqual([
      { row: 0, col: 1, value: '7' },
      { row: 1, col: 1, value: '7' },
    ]);
  });
  it('treats NULL (parsed as null) as SQL NULL', () => {
    const plan = planPaste({
      block: [[null]],
      anchor: { row: 0, pos: 0 },
      visibleCols: VIS,
      rowCount: 1,
      typeOf,
    });
    expect(plan.writes).toEqual([{ row: 0, col: 0, value: null }]);
  });
  it('ignores an empty block', () => {
    expect(
      planPaste({ block: [], anchor: { row: 0, pos: 0 }, visibleCols: VIS, rowCount: 1, typeOf })
        .writes,
    ).toEqual([]);
  });
});

describe('isTextLikeType', () => {
  it('recognises text-ish types', () => {
    for (const t of ['text', 'varchar(20)', 'character varying', 'bpchar', 'citext']) {
      expect(isTextLikeType(t)).toBe(true);
    }
    for (const t of ['int4', 'uuid', 'date', 'jsonb', undefined])
      expect(isTextLikeType(t)).toBe(false);
  });
});

describe('find & replace', () => {
  const cells = [
    { row: 0, col: 0, text: 'Foo bar foo' },
    { row: 1, col: 0, text: 'nothing' },
    { row: 2, col: 0, text: null },
    { row: 3, col: 0, text: undefined },
    { row: 4, col: 0, text: 'FOO' },
  ];
  it('is case-insensitive by default and counts occurrences', () => {
    const plan = planFindReplace(cells, {
      find: 'foo',
      replace: 'x',
      caseSensitive: false,
      regex: false,
    });
    expect(plan.writes).toEqual([
      { row: 0, col: 0, value: 'x bar x' },
      { row: 4, col: 0, value: 'x' },
    ]);
    expect(plan.cellCount).toBe(2);
    expect(plan.occurrences).toBe(3);
    expect(describeFindPlan(plan)).toBe('2 cells will change (3 replacements).');
  });
  it('honours case sensitivity and skips NULL cells', () => {
    const plan = planFindReplace(cells, {
      find: 'foo',
      replace: 'x',
      caseSensitive: true,
      regex: false,
    });
    expect(plan.writes).toEqual([{ row: 0, col: 0, value: 'Foo bar x' }]);
  });
  it('treats the pattern and replacement literally unless regex is on', () => {
    const lit = planFindReplace([{ row: 0, col: 0, text: 'a.b (c) a.b' }], {
      find: 'a.b',
      replace: '$&!',
      caseSensitive: true,
      regex: false,
    });
    expect(lit.writes[0]?.value).toBe('$&! (c) $&!');
  });
  it('supports regex with capture groups', () => {
    const plan = planFindReplace([{ row: 0, col: 0, text: 'john smith' }], {
      find: '(\\w+) (\\w+)',
      replace: '$2, $1',
      caseSensitive: true,
      regex: true,
    });
    expect(plan.writes[0]?.value).toBe('smith, john');
  });
  it('matches whole cells only when asked', () => {
    const plan = planFindReplace(
      [
        { row: 0, col: 0, text: 'foo' },
        { row: 1, col: 0, text: 'foobar' },
      ],
      { find: 'foo', replace: 'x', caseSensitive: true, regex: false, wholeCell: true },
    );
    expect(plan.writes).toEqual([{ row: 0, col: 0, value: 'x' }]);
  });
  it('reports bad patterns and empty needles instead of throwing', () => {
    const bad = planFindReplace(cells, {
      find: '(',
      replace: '',
      caseSensitive: false,
      regex: true,
    });
    expect(bad.error).toMatch(/Invalid regular expression/);
    expect(bad.writes).toEqual([]);
    expect(compileFindPattern({ find: '', caseSensitive: false, regex: false })).toEqual({
      error: 'Enter text to find.',
    });
  });
  it('does not stage cells whose text would not change', () => {
    const plan = planFindReplace([{ row: 0, col: 0, text: 'x' }], {
      find: 'x',
      replace: 'x',
      caseSensitive: true,
      regex: false,
    });
    expect(plan.writes).toEqual([]);
    expect(describeFindPlan(plan)).toBe('No matches.');
  });
  it('can blank values out with an empty replacement', () => {
    const plan = planFindReplace([{ row: 0, col: 0, text: 'abc' }], {
      find: 'b',
      replace: '',
      caseSensitive: true,
      regex: false,
    });
    expect(plan.writes[0]?.value).toBe('ac');
  });
});

describe('loadedRowsNote', () => {
  it('only speaks up when the table is larger than what is loaded', () => {
    expect(loadedRowsNote(300, 12408)).toMatch(/Only the 300 loaded rows .* 12,408/);
    expect(loadedRowsNote(300, 300)).toBeNull();
    expect(loadedRowsNote(300, null)).toBeNull();
  });
});

describe('describeBulkResult', () => {
  it('summarises what was staged, skipped and clamped', () => {
    expect(describeBulkResult({ verb: 'Filled down', staged: 12, unchanged: 0, skipped: 0 })).toBe(
      'Filled down: 12 cells staged.',
    );
    expect(
      describeBulkResult({
        verb: 'Pasted',
        staged: 1,
        unchanged: 2,
        skipped: 3,
        loadedNote: 'Only the 300 loaded rows were changed — the table has 900.',
      }),
    ).toBe(
      'Pasted: 1 cell staged · 2 already matched · 3 skipped (rows marked for deletion or not loaded). Only the 300 loaded rows were changed — the table has 900.',
    );
  });
  it('explains an empty result', () => {
    expect(describeBulkResult({ verb: 'x', staged: 0, unchanged: 4, skipped: 0 })).toMatch(
      /already hold that value/,
    );
    expect(describeBulkResult({ verb: 'x', staged: 0, unchanged: 0, skipped: 0 })).toBe(
      'Nothing was staged.',
    );
  });
});
