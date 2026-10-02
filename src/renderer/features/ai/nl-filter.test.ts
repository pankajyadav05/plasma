import { describe, expect, it } from 'vitest';
import { nlRowsToFilters, whereFragmentQuery } from './nl-filter';

describe('nl filter helpers', () => {
  it('maps suggestion rows to filter-model rows with fresh ids', () => {
    let n = 0;
    expect(
      nlRowsToFilters(
        [
          { column: 'total', op: '>', value: '500' },
          { column: 'note', op: 'IS NULL', value: '' },
        ],
        () => `f${++n}`,
      ),
    ).toEqual([
      { id: 'f1', column: 'total', op: '>', value: '500' },
      { id: 'f2', column: 'note', op: 'IS NULL', value: '' },
    ]);
  });

  it('builds a quoted, limited SELECT for a WHERE fragment', () => {
    expect(whereFragmentQuery('public', 'or"ders', " total > 5 OR status = 'x' ")).toBe(
      `SELECT *\nFROM "public"."or""ders"\nWHERE total > 5 OR status = 'x'\nLIMIT 200;`,
    );
  });
});
