import { describe, expect, it } from 'vitest';
import {
  type CompareOptions,
  type CompareSource,
  DEFAULT_COMPARE_OPTIONS,
  compareResults,
  decimalWithin,
  diffToTable,
  instantToken,
} from './result-compare';

const src = (columns: string[], rows: unknown[][], types?: string[]): CompareSource => ({
  columns,
  rows,
  types,
});
const opts = (o: Partial<CompareOptions> = {}): CompareOptions => ({
  ...DEFAULT_COMPARE_OPTIONS,
  ...o,
});
const run = { yieldFn: async () => {}, sliceRows: 3 };

describe('review fixes: compare engine', () => {
  it('P1-5: same-named columns pair by position and are never collapsed', async () => {
    const l = src(['id', 'name', 'id'], [[1, 'a', 1]]);
    const r = src(['id', 'name', 'id'], [[1, 'a', 9]]);
    const keyless = await compareResults(l, r, opts(), run);
    expect(keyless.summary).toMatchObject({ removed: 1, added: 1, unchanged: 0 });
    expect(keyless.onlyRight).toEqual([]);
    const keyed = await compareResults(l, r, opts({ keys: ['name'] }), run);
    expect(keyed.summary.changed).toBe(1);
    expect(keyed.columns).toEqual(['name', 'id', 'id (2)']);
    expect(keyed.rightIndex).toEqual([1, 0, 2]);
    expect(keyed.rows[0]!.changed).toEqual([2]);
    expect(keyed.pairedByPosition).toEqual(['id']);
  });

  it('P1-5: an extra same-named column on one side is reported, not merged', async () => {
    const d = await compareResults(
      src(['id', 'id'], [[1, 2]]),
      src(['id'], [[1]]),
      opts({ keys: ['id'] }),
      run,
    );
    expect(d.onlyLeft).toEqual(['id (2)']);
  });

  it('P2-4: tolerance never hides a bigint or long-decimal difference', async () => {
    const types = ['int4', 'int8'];
    const mk = (a: string, b: string, o: Partial<CompareOptions>) =>
      compareResults(
        src(['id', 'v'], [[1, a]], types),
        src(['id', 'v'], [[1, b]], types),
        opts({ keys: ['id'], ...o }),
        run,
      );
    expect(
      (await mk('9007199254740993', '9007199254740992', { tolerance: 0 })).summary.changed,
    ).toBe(1);
    // difference 1 > 0.001: a float compare would call these equal
    expect(
      (await mk('9007199254740993', '9007199254740992', { tolerance: 0.001 })).summary.changed,
    ).toBe(1);
    expect(
      (await mk('9007199254740993', '9007199254740992', { tolerance: 1 })).summary.unchanged,
    ).toBe(1);
    const dtypes = ['int4', 'numeric'];
    const dec = (tol: number) =>
      compareResults(
        src(['id', 'v'], [[1, '0.10000000000000000001']], dtypes),
        src(['id', 'v'], [[1, '0.1']], dtypes),
        opts({ keys: ['id'], tolerance: tol }),
        run,
      );
    expect((await dec(1e-25)).summary.changed).toBe(1);
    expect((await dec(0.001)).summary.unchanged).toBe(1);
    expect(decimalWithin('100', '99.5', '0.5')).toBe(true);
    expect(decimalWithin('100', '99.4', '0.5')).toBe(false);
  });

  it('P2-6: timestamptz compares as an instant across session time zones', async () => {
    const types = ['int4', 'timestamptz'];
    const d = await compareResults(
      src(
        ['id', 't'],
        [
          [1, '2026-03-01 12:00:00+00'],
          [2, '2026-03-01 12:00:00.5+00'],
        ],
        types,
      ),
      src(
        ['id', 't'],
        [
          [1, '2026-03-01 07:00:00-05'],
          [2, '2026-03-01 07:00:00.6-05'],
        ],
        types,
      ),
      opts({ keys: ['id'] }),
      run,
    );
    expect(d.rows.map((r) => r.kind)).toEqual(['unchanged', 'changed']);
    expect(instantToken('2026-03-01 12:00:00+00')).toBe(instantToken('2026-03-01T17:30:00+05:30'));
  });

  it('P2-7: the export lists every duplicate row', async () => {
    const l = src(
      ['id', 'v'],
      [
        [1, 'a'],
        [1, 'b'],
      ],
    );
    const r = src(['id', 'v'], [[1, 'c']]);
    const d = await compareResults(l, r, opts({ keys: ['id'] }), run);
    const t = diffToTable(d, l, r, new Set(['duplicate']));
    expect(t.rows).toEqual([
      ['duplicate', '', 1, 'a', null],
      ['duplicate', '', 1, 'b', null],
      ['duplicate', '', 1, null, 'c'],
    ]);
  });
});
