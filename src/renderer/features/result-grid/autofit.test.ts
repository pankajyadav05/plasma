import { describe, expect, it } from 'vitest';
import { AUTOFIT_MAX_PX, AUTOFIT_MIN_PX, autoFitWidth, columnsToFreeze } from './autofit';

const measure = (s: string) => s.length * 8;

describe('autoFitWidth', () => {
  it('fits the widest cell plus padding', () => {
    expect(autoFitWidth('id', ['1', '1234567890', '22'], measure, { padding: 20 })).toBe(100);
  });
  it('never goes narrower than the header', () => {
    expect(autoFitWidth('a_long_header_name', ['1'], measure, { headerExtra: 40 })).toBe(
      18 * 8 + 40,
    );
  });
  it('measures the header with its own font when given', () => {
    expect(
      autoFitWidth('abcd', ['x'], measure, { measureHeader: (t) => t.length * 10, headerExtra: 0 }),
    ).toBe(60);
  });
  it('clamps to min and max', () => {
    expect(autoFitWidth('', [], measure)).toBe(AUTOFIT_MIN_PX);
    expect(autoFitWidth('h', ['x'.repeat(1000)], measure)).toBe(AUTOFIT_MAX_PX);
  });
  it('skips NULLs and measures only the first line of multi-line text', () => {
    expect(
      autoFitWidth('h', [null, undefined, `ab\n${'x'.repeat(100)}`], measure, {
        padding: 0,
        min: 0,
        headerExtra: 0,
      }),
    ).toBe(16);
  });
  it('only samples the first rows', () => {
    const texts = ['a', ...Array(5).fill('b'), 'z'.repeat(50)];
    expect(
      autoFitWidth('h', texts, measure, { sampleRows: 3, padding: 0, min: 0, headerExtra: 0 }),
    ).toBe(8);
  });
});

describe('columnsToFreeze', () => {
  const names = ['id', 'name', 'email', 'created'];
  it('pins everything up to and including the target', () => {
    expect(columnsToFreeze(names, 'email', new Set())).toEqual(['id', 'name', 'email']);
  });
  it('skips columns that are already pinned and ignores unknown targets', () => {
    expect(columnsToFreeze(names, 'name', new Set(['id']))).toEqual(['name']);
    expect(columnsToFreeze(names, 'nope', new Set())).toEqual([]);
  });
});
