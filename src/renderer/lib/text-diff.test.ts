import { describe, expect, it } from 'vitest';
import { applyFixToBuffer, diffLines, diffWords, sameStatement } from './text-diff';

const text = (segs: Array<{ text: string }> | undefined) =>
  (segs ?? []).map((s) => s.text).join('');

describe('diffWords', () => {
  it('marks only the changed tokens on each side', () => {
    const d = diffWords('select nme from users', 'select name from users');
    expect(d.left).toEqual([
      { text: 'select ', changed: false },
      { text: 'nme', changed: true },
      { text: ' from users', changed: false },
    ]);
    expect(d.right.find((s) => s.changed)?.text).toBe('name');
    expect(text(d.left)).toBe('select nme from users');
    expect(text(d.right)).toBe('select name from users');
  });

  it('handles empty and identical input', () => {
    expect(diffWords('', '').left).toEqual([]);
    expect(diffWords('a b', 'a b').right).toEqual([{ text: 'a b', changed: false }]);
  });
});

describe('diffLines', () => {
  it('pairs replaced lines as changes and keeps equal lines', () => {
    const rows = diffLines(
      'select *\nfrom usrs\nwhere id = 1',
      'select *\nfrom users\nwhere id = 1',
    );
    expect(rows.map((r) => r.kind)).toEqual(['same', 'change', 'same']);
    expect(text(rows[1]!.left)).toBe('from usrs');
    expect(text(rows[1]!.right)).toBe('from users');
  });

  it('reports pure additions and removals', () => {
    const rows = diffLines('a\nb', 'a\nb\nc');
    expect(rows.map((r) => r.kind)).toEqual(['same', 'same', 'add']);
    const rows2 = diffLines('a\nb\nc', 'a');
    expect(rows2.map((r) => r.kind)).toEqual(['same', 'remove', 'remove']);
  });

  it('pairs unequal blocks then leaves the rest', () => {
    const rows = diffLines('x\ny', 'p\nq\nr');
    expect(rows.map((r) => r.kind)).toEqual(['change', 'change', 'add']);
  });
});

describe('sameStatement', () => {
  it('ignores whitespace around and a trailing semicolon', () => {
    expect(sameStatement(' select 1;\n', 'select 1')).toBe(true);
    expect(sameStatement('select 1', 'select 2')).toBe(false);
  });
});

describe('applyFixToBuffer', () => {
  const buffer = 'select 1;\nselect nme from users;\nselect 3;';
  const bad = 'select nme from users';
  const start = buffer.indexOf(bad);

  it('replaces by the recorded range', () => {
    expect(
      applyFixToBuffer(buffer, { start, end: start + bad.length }, bad, 'select name from users'),
    ).toBe('select 1;\nselect name from users;\nselect 3;');
  });

  it('falls back to a unique text match when the range is stale or missing', () => {
    expect(applyFixToBuffer(buffer, { start: 0, end: 3 }, bad, 'X')).toBe(
      'select 1;\nX;\nselect 3;',
    );
    expect(applyFixToBuffer(buffer, null, bad, 'X')).toBe('select 1;\nX;\nselect 3;');
  });

  it('refuses when the statement is gone or ambiguous', () => {
    expect(applyFixToBuffer('select 1', null, bad, 'X')).toBeNull();
    expect(applyFixToBuffer(`${bad};\n${bad};`, null, bad, 'X')).toBeNull();
  });
});
