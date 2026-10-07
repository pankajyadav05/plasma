import { describe, expect, it } from 'vitest';
import {
  type CompareOptions,
  type CompareSource,
  DEFAULT_COMPARE_OPTIONS,
  MAX_COMPARE_ROWS,
  canonicalDecimal,
  cellToken,
  compareResults,
  diffToTable,
  isNumericType,
  leftCell,
  parseSavedComparison,
  rightCell,
  suggestKeys,
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
const kinds = (d: Awaited<ReturnType<typeof compareResults>>) => d.rows.map((r) => r.kind);

describe('compareResults: basic keyed diff', () => {
  const a = src(
    ['id', 'name', 'qty'],
    [
      [1, 'ann', 10],
      [2, 'bob', 20],
      [3, 'cy', 30],
    ],
  );
  const b = src(
    ['id', 'name', 'qty'],
    [
      [1, 'ann', 10],
      [2, 'bobby', 20],
      [4, 'dee', 40],
    ],
  );

  it('counts added, removed, changed, unchanged', async () => {
    const d = await compareResults(a, b, opts({ keys: ['id'] }), run);
    expect(d.summary).toEqual({ added: 1, removed: 1, changed: 1, unchanged: 1, duplicates: 0 });
    expect(kinds(d)).toEqual(['unchanged', 'changed', 'removed', 'added']);
  });

  it('reports which cells changed and reads old/new back', async () => {
    const d = await compareResults(a, b, opts({ keys: ['id'] }), run);
    const changed = d.rows[1]!;
    expect(changed.changed.map((c) => d.columns[c])).toEqual(['name']);
    const nameCol = d.columns.indexOf('name');
    expect(leftCell(d, a, changed, nameCol)).toBe('bob');
    expect(rightCell(d, b, changed, nameCol)).toBe('bobby');
    expect(d.changedPerColumn[nameCol]).toBe(1);
  });

  it('puts key columns first', async () => {
    const d = await compareResults(
      src(['name', 'id'], [['x', 1]]),
      src(['name', 'id'], [['x', 1]]),
      opts({ keys: ['id'] }),
      run,
    );
    expect(d.columns).toEqual(['id', 'name']);
  });

  it('handles composite keys', async () => {
    const l = src(
      ['a', 'b', 'v'],
      [
        [1, 1, 'x'],
        [1, 2, 'y'],
      ],
    );
    const r = src(
      ['a', 'b', 'v'],
      [
        [1, 2, 'y'],
        [1, 1, 'z'],
      ],
    );
    const d = await compareResults(l, r, opts({ keys: ['a', 'b'] }), run);
    expect(d.summary).toMatchObject({ changed: 1, unchanged: 1, added: 0, removed: 0 });
  });

  it('is empty-safe', async () => {
    const d = await compareResults(src(['id'], []), src(['id'], []), opts({ keys: ['id'] }), run);
    expect(d.rows).toEqual([]);
    expect(d.summary.unchanged).toBe(0);
  });

  it('left empty makes everything added; right empty makes everything removed', async () => {
    const l = src(['id'], []);
    const r = src(['id'], [[1], [2]]);
    expect((await compareResults(l, r, opts({ keys: ['id'] }), run)).summary.added).toBe(2);
    expect((await compareResults(r, l, opts({ keys: ['id'] }), run)).summary.removed).toBe(2);
  });
});

describe('compareResults: columns', () => {
  it('matches columns by name regardless of order and case', async () => {
    const d = await compareResults(
      src(['ID', 'Name'], [[1, 'a']]),
      src(['name', 'id'], [['a', 1]]),
      opts({ keys: ['id'] }),
      run,
    );
    expect(d.summary.unchanged).toBe(1);
  });

  it('reports columns on one side only and does not compare them', async () => {
    const d = await compareResults(
      src(['id', 'extra_a'], [[1, 'x']]),
      src(['id', 'extra_b'], [[1, 'y']]),
      opts({ keys: ['id'] }),
      run,
    );
    expect(d.onlyLeft).toEqual(['extra_a']);
    expect(d.onlyRight).toEqual(['extra_b']);
    expect(d.summary.unchanged).toBe(1);
  });

  it('ignores columns such as updated_at', async () => {
    const l = src(['id', 'updated_at'], [[1, '2024-01-01']]);
    const r = src(['id', 'updated_at'], [[1, '2025-05-05']]);
    expect((await compareResults(l, r, opts({ keys: ['id'] }), run)).summary.changed).toBe(1);
    const d = await compareResults(l, r, opts({ keys: ['id'], ignore: ['UPDATED_AT'] }), run);
    expect(d.summary.unchanged).toBe(1);
    expect(d.ignored).toEqual(['updated_at']);
    expect(d.columns).toEqual(['id']);
  });

  it('rejects a key that is not in both results', async () => {
    await expect(
      compareResults(src(['id'], []), src(['id'], []), opts({ keys: ['nope'] }), run),
    ).rejects.toMatchObject({ code: 'missing-key' });
  });

  it('rejects results with nothing in common', async () => {
    await expect(
      compareResults(src(['a'], [[1]]), src(['b'], [[1]]), opts(), run),
    ).rejects.toMatchObject({ code: 'no-columns' });
  });
});

describe('compareResults: values', () => {
  const one = (l: unknown, r: unknown, o: Partial<CompareOptions> = {}, types?: string[]) =>
    compareResults(
      src(['id', 'v'], [[1, l]], types ? ['int4', ...types] : undefined),
      src(['id', 'v'], [[1, r]], types ? ['int4', ...types] : undefined),
      opts({ keys: ['id'], ...o }),
      run,
    );

  it('NULL equals NULL and differs from empty string', async () => {
    expect((await one(null, null)).summary.unchanged).toBe(1);
    expect((await one(null, '')).summary.changed).toBe(1);
    expect((await one('', null)).summary.changed).toBe(1);
  });

  it('numeric columns compare as numbers (scale does not matter)', async () => {
    expect((await one('1.50', '1.5', {}, ['numeric'])).summary.unchanged).toBe(1);
    expect((await one('1.50', '1.51', {}, ['numeric'])).summary.changed).toBe(1);
    expect((await one(1, '1', {}, ['int4'])).summary.unchanged).toBe(1);
  });

  it('text columns that look numeric stay text', async () => {
    expect((await one('007', '7', {}, ['text'])).summary.changed).toBe(1);
  });

  it('bigints past 2^53 compare exactly', async () => {
    const a = '9007199254740993';
    const b = '9007199254740992';
    expect((await one(a, b, {}, ['int8'])).summary.changed).toBe(1);
    expect((await one(a, a, {}, ['int8'])).summary.unchanged).toBe(1);
  });

  it('applies the numeric tolerance only to numeric columns', async () => {
    expect((await one(1.0, 1.004, { tolerance: 0.01 }, ['float8'])).summary.unchanged).toBe(1);
    expect((await one(1.0, 1.02, { tolerance: 0.01 }, ['float8'])).summary.changed).toBe(1);
    expect((await one('a', 'b', { tolerance: 100 }, ['text'])).summary.changed).toBe(1);
  });

  it('ignores case and whitespace when asked', async () => {
    expect((await one('Hello World', 'hello world')).summary.changed).toBe(1);
    expect((await one('Hello World', 'hello world', { ignoreCase: true })).summary.unchanged).toBe(
      1,
    );
    expect((await one('a  b ', ' a b')).summary.changed).toBe(1);
    expect((await one('a  b ', ' a b', { trimWhitespace: true })).summary.unchanged).toBe(1);
  });

  it('compares json regardless of key order', async () => {
    expect((await one({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).summary.unchanged).toBe(1);
    expect((await one({ a: 1 }, { a: 2 })).summary.changed).toBe(1);
  });

  it('compares booleans, dates and bytes', async () => {
    expect((await one(true, false)).summary.changed).toBe(1);
    expect(
      (await one(new Date('2024-01-01T00:00:00Z'), new Date('2024-01-01T00:00:00Z'))).summary
        .unchanged,
    ).toBe(1);
    expect((await one(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).summary.changed).toBe(1);
  });

  it('keys match across number and numeric-string forms', async () => {
    const d = await compareResults(
      src(['id', 'v'], [['1', 'a']], ['int8', 'text']),
      src(['id', 'v'], [[1, 'a']], ['int4', 'text']),
      opts({ keys: ['id'] }),
      run,
    );
    expect(d.summary.unchanged).toBe(1);
  });
});

describe('compareResults: duplicates', () => {
  it('reports duplicate keys instead of merging them', async () => {
    const l = src(
      ['id', 'v'],
      [
        [1, 'a'],
        [1, 'b'],
        [2, 'c'],
      ],
    );
    const r = src(
      ['id', 'v'],
      [
        [1, 'a'],
        [2, 'c'],
      ],
    );
    const d = await compareResults(l, r, opts({ keys: ['id'] }), run);
    expect(d.summary).toMatchObject({ duplicates: 1, unchanged: 1, changed: 0 });
    const dup = d.rows.find((x) => x.kind === 'duplicate')!;
    expect(dup.lis).toEqual([0, 1]);
    expect(dup.ris).toEqual([0]);
  });

  it('reports a duplicate that exists on the right side only', async () => {
    const d = await compareResults(
      src(['id'], [[9]]),
      src(['id'], [[1], [1], [9]]),
      opts({ keys: ['id'] }),
      run,
    );
    expect(d.summary.duplicates).toBe(1);
    expect(d.rows.find((x) => x.kind === 'duplicate')?.ris).toEqual([0, 1]);
  });
});

describe('compareResults: no key (whole-row multiset)', () => {
  it('pairs equal rows and reports the surplus', async () => {
    const l = src(
      ['a', 'b'],
      [
        [1, 'x'],
        [1, 'x'],
        [2, 'y'],
      ],
    );
    const r = src(
      ['a', 'b'],
      [
        [1, 'x'],
        [3, 'z'],
      ],
    );
    const d = await compareResults(l, r, opts(), run);
    expect(d.summary).toEqual({ added: 1, removed: 2, changed: 0, unchanged: 1, duplicates: 0 });
  });
});

describe('compareResults: ordering, cap, progress, cancel', () => {
  it('lists left rows in left order, then right-only rows in right order', async () => {
    const l = src(['id'], [[3], [1], [2]]);
    const r = src(['id'], [[9], [2], [8]]);
    const d = await compareResults(l, r, opts({ keys: ['id'] }), run);
    expect(d.rows.map((x) => [x.kind, x.li, x.ri])).toEqual([
      ['removed', 0, -1],
      ['removed', 1, -1],
      ['unchanged', 2, 1],
      ['added', -1, 0],
      ['added', -1, 2],
    ]);
  });

  it('refuses more than the row cap with a clear message', async () => {
    const big = { columns: ['id'], rows: new Array(MAX_COMPARE_ROWS + 1).fill([1]) };
    await expect(
      compareResults(big, src(['id'], []), opts({ keys: ['id'] }), run),
    ).rejects.toMatchObject({ code: 'too-large', message: expect.stringContaining('200,000') });
  });

  it('handles 200k rows per side and yields between slices', async () => {
    const n = MAX_COMPARE_ROWS;
    const l = { columns: ['id', 'v'], rows: Array.from({ length: n }, (_, i) => [i, `v${i}`]) };
    const r = {
      columns: ['id', 'v'],
      rows: Array.from({ length: n }, (_, i) => [i, i % 1000 === 0 ? 'changed' : `v${i}`]),
    };
    let yields = 0;
    const d = await compareResults(l, r, opts({ keys: ['id'] }), {
      yieldFn: async () => {
        yields++;
      },
    });
    expect(d.summary.changed).toBe(200);
    expect(d.summary.unchanged).toBe(n - 200);
    expect(yields).toBeGreaterThan(50);
  }, 20_000);

  it('reports progress and honours cancel', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => [i]);
    const seen: number[] = [];
    await compareResults(src(['id'], rows), src(['id'], rows), opts({ keys: ['id'] }), {
      ...run,
      onProgress: (done) => seen.push(done),
    });
    expect(seen.at(-1)).toBe(100);
    let n = 0;
    await expect(
      compareResults(src(['id'], rows), src(['id'], rows), opts({ keys: ['id'] }), {
        ...run,
        isCancelled: () => ++n > 2,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });
});

describe('helpers', () => {
  it('canonicalDecimal', () => {
    expect(canonicalDecimal('007.500')).toBe('7.5');
    expect(canonicalDecimal('-0.0')).toBe('0');
    expect(canonicalDecimal('+3')).toBe('3');
    expect(canonicalDecimal('1e3')).toBe('1000');
    expect(canonicalDecimal('abc')).toBeNull();
    expect(canonicalDecimal('')).toBeNull();
  });

  it('isNumericType', () => {
    for (const t of [
      'int4',
      'int8',
      'numeric',
      'float8',
      'DOUBLE',
      'UInt32',
      'bigint',
      'decimal(10,2)',
    ]) {
      expect(isNumericType(t)).toBe(true);
    }
    for (const t of ['text', 'varchar', 'uuid', 'timestamptz', 'jsonb', undefined]) {
      expect(isNumericType(t)).toBe(false);
    }
  });

  it('cellToken separates null from the string "null"', () => {
    const o = DEFAULT_COMPARE_OPTIONS;
    expect(cellToken(null, false, o)).not.toBe(cellToken('null', false, o));
  });
});

describe('suggestKeys', () => {
  it('prefers a primary key that is unique in the data', () => {
    const s = src(
      ['id', 'email', 'n'],
      [
        [1, 'a', 1],
        [2, 'b', 1],
      ],
    );
    expect(suggestKeys(s, s, [['id']])[0]).toEqual({ keys: ['id'], reason: 'primary key' });
  });

  it('falls back to unique id-like columns, non-null and unique on both sides', () => {
    const l = src(
      ['n', 'user_id'],
      [
        [1, 10],
        [1, 11],
      ],
    );
    const r = src(
      ['n', 'user_id'],
      [
        [1, 10],
        [1, 12],
      ],
    );
    expect(suggestKeys(l, r)[0]).toEqual({ keys: ['user_id'], reason: 'unique column' });
    const dup = src(
      ['n', 'user_id'],
      [
        [1, 10],
        [1, 10],
      ],
    );
    expect(suggestKeys(l, dup)).toEqual([]);
  });

  it('never suggests a column with NULLs', () => {
    const s = src(['a'], [[1], [null]]);
    expect(suggestKeys(s, s)).toEqual([]);
  });

  it('suggests a unique pair when no single column works', () => {
    const s = src(
      ['a', 'b'],
      [
        [1, 1],
        [1, 2],
        [2, 1],
      ],
    );
    expect(suggestKeys(s, s)[0]).toEqual({ keys: ['a', 'b'], reason: 'unique columns' });
  });
});

describe('diffToTable', () => {
  it('flattens the diff with A/B columns and the changed list', async () => {
    const l = src(
      ['id', 'name'],
      [
        [1, 'a'],
        [2, 'b'],
      ],
    );
    const r = src(
      ['id', 'name'],
      [
        [1, 'z'],
        [3, 'c'],
      ],
    );
    const d = await compareResults(l, r, opts({ keys: ['id'] }), run);
    const t = diffToTable(d, l, r, new Set(['changed', 'added', 'removed']));
    expect(t.columns).toEqual(['diff', 'changed_columns', 'id', 'name (A)', 'name (B)']);
    expect(t.rows).toEqual([
      ['changed', 'name', 1, 'a', 'z'],
      ['removed', '', 2, 'b', null],
      ['added', '', 3, null, 'c'],
    ]);
  });
});

describe('parseSavedComparison', () => {
  const good = {
    id: 'c1',
    name: 'staging vs prod',
    a: { connectionId: 'x', sql: 'select 1' },
    b: { connectionId: null, sql: 'select 1' },
    options: { keys: ['id'], ignore: ['updated_at'], tolerance: 0.5, ignoreCase: true },
    savedAt: 5,
  };
  it('accepts a good definition and fills defaults', () => {
    const p = parseSavedComparison(good)!;
    expect(p.options).toEqual({
      keys: ['id'],
      ignore: ['updated_at'],
      tolerance: 0.5,
      ignoreCase: true,
      trimWhitespace: false,
    });
  });
  it('rejects junk', () => {
    expect(parseSavedComparison(null)).toBeNull();
    expect(parseSavedComparison({ ...good, a: { connectionId: 1, sql: 'x' } })).toBeNull();
    expect(parseSavedComparison({ ...good, b: { connectionId: null, sql: ' ' } })).toBeNull();
    expect(parseSavedComparison({ ...good, name: 4 })).toBeNull();
  });
  it('clamps a bad tolerance', () => {
    expect(parseSavedComparison({ ...good, options: { tolerance: -1 } })!.options.tolerance).toBe(
      0,
    );
  });
});
