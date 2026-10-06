import { describe, expect, it } from 'vitest';
import {
  closeColumnNames,
  describeTableView,
  isEmptyTableView,
  trimViewToChanges,
  validateTableView,
} from './table-view';

const COLS = [
  { name: 'id', dataType: 'integer' },
  { name: 'status', dataType: 'text' },
  { name: 'total', dataType: 'numeric' },
  { name: 'created_at', dataType: 'timestamp with time zone' },
  { name: 'ship_date', dataType: 'date' },
];

describe('validateTableView', () => {
  it('accepts a full view', () => {
    const r = validateTableView(
      {
        columns: ['id', 'total', 'created_at'],
        sort: [{ column: 'created_at', direction: 'desc' }],
        filters: [{ column: 'status', op: '=', value: 'paid' }],
        limit: 10,
      },
      COLS,
    );
    expect(r).toEqual({
      ok: true,
      view: {
        columns: ['id', 'total', 'created_at'],
        sort: [{ column: 'created_at', direction: 'desc' }],
        filters: [{ column: 'status', op: '=', value: 'paid' }],
        limit: 10,
      },
    });
  });

  it('treats null and missing parts as unchanged', () => {
    const r = validateTableView({ columns: null, limit: null }, COLS);
    expect(r).toEqual({ ok: true, view: {} });
    expect(isEmptyTableView({})).toBe(true);
  });

  it('keeps an explicit empty sort / filters (clear them)', () => {
    const r = validateTableView({ sort: [], filters: [] }, COLS);
    expect(r).toEqual({ ok: true, view: { sort: [], filters: [] } });
    expect(isEmptyTableView({ sort: [] })).toBe(false);
  });

  it('rejects an unknown column, names it and lists close names', () => {
    const r = validateTableView({ columns: ['id', 'creatd_at'] }, COLS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('"creatd_at"');
      expect(r.error).toContain('created_at');
    }
  });

  it('does not fix case or whitespace in column names', () => {
    expect(validateTableView({ columns: ['ID'] }, COLS).ok).toBe(false);
    expect(validateTableView({ sort: [{ column: ' id', direction: 'asc' }] }, COLS).ok).toBe(false);
    expect(
      validateTableView({ filters: [{ column: 'Status', op: '=', value: 'x' }] }, COLS).ok,
    ).toBe(false);
  });

  it('keeps at least one column', () => {
    expect(validateTableView({ columns: [] }, COLS).ok).toBe(false);
  });

  it('bounds the limit to whole numbers 1..1000', () => {
    for (const bad of [0, -1, 1001, 1.5, '10', Number.NaN]) {
      expect(validateTableView({ limit: bad }, COLS).ok).toBe(false);
    }
    expect(validateTableView({ limit: 1 }, COLS).ok).toBe(true);
    expect(validateTableView({ limit: 1000 }, COLS).ok).toBe(true);
  });

  it('caps filters at 20 and sort keys at 10', () => {
    const f = { column: 'id', op: '=', value: '1' };
    expect(validateTableView({ filters: Array(20).fill(f) }, COLS).ok).toBe(true);
    expect(validateTableView({ filters: Array(21).fill(f) }, COLS).ok).toBe(false);
    const many = Array.from({ length: 11 }, () => ({ column: 'id', direction: 'asc' }));
    expect(validateTableView({ sort: many }, COLS).ok).toBe(false);
  });

  it('validates operators and values like the NL filter', () => {
    expect(
      validateTableView({ filters: [{ column: 'id', op: 'REGEX', value: 'x' }] }, COLS).ok,
    ).toBe(false);
    expect(validateTableView({ filters: [{ column: 'id', op: '=', value: '' }] }, COLS).ok).toBe(
      false,
    );
    const nullary = validateTableView(
      { filters: [{ column: 'status', op: 'is not null', value: 'junk' }] },
      COLS,
    );
    expect(nullary).toEqual({
      ok: true,
      view: { filters: [{ column: 'status', op: 'IS NOT NULL', value: '' }] },
    });
    const num = validateTableView({ filters: [{ column: 'total', op: '>', value: 500 }] }, COLS);
    expect(num.ok && num.view.filters?.[0]?.value).toBe('500');
  });

  it('rejects a bad sort direction and non-objects', () => {
    expect(validateTableView({ sort: [{ column: 'id', direction: 'up' }] }, COLS).ok).toBe(false);
    expect(validateTableView(null, COLS).ok).toBe(false);
    expect(validateTableView([], COLS).ok).toBe(false);
  });
});

describe('describeTableView', () => {
  it('describes columns, sort, filter and limit', () => {
    expect(
      describeTableView(
        {
          columns: ['a', 'b', 'c'],
          sort: [{ column: 'created_at', direction: 'desc' }],
          filters: [{ column: 'status', op: '=', value: 'paid' }],
          limit: 10,
        },
        COLS,
      ),
    ).toEqual([
      'Columns: a, b, c',
      'Sort: created_at newest first',
      'Filter: status = paid',
      'Limit: 10 rows',
    ]);
  });

  it('uses oldest first / ascending / descending by type', () => {
    expect(
      describeTableView(
        {
          sort: [
            { column: 'ship_date', direction: 'asc' },
            { column: 'total', direction: 'desc' },
            { column: 'id', direction: 'asc' },
          ],
        },
        COLS,
      ),
    ).toEqual(['Sort: ship_date oldest first, total descending, id ascending']);
  });

  it('describes cleared parts, null filters and a single row', () => {
    expect(
      describeTableView({
        sort: [],
        filters: [{ column: 'status', op: 'IS NULL', value: '' }],
        limit: 1,
      }),
    ).toEqual(['Sort: none', 'Filter: status IS NULL', 'Limit: 1 row']);
    expect(describeTableView({ filters: [] })).toEqual(['Filters: none']);
  });

  it('describes nothing for an empty view', () => {
    expect(describeTableView({})).toEqual([]);
  });
});

describe('closeColumnNames', () => {
  it('finds near misses', () => {
    expect(closeColumnNames('creat_at', ['id', 'created_at'])).toEqual(['created_at']);
    expect(closeColumnNames('zzzzzz', ['id', 'created_at'])).toEqual([]);
  });
});

describe('trimViewToChanges', () => {
  const current = {
    columns: ['id', 'status'],
    sort: [{ column: 'id', direction: 'asc' as const }],
    filters: [{ column: 'status', op: '=', value: 'paid' }],
    pageSize: 50,
  };

  it('keeps only the parts that differ from what is shown', () => {
    expect(
      trimViewToChanges(
        {
          columns: ['id', 'status'],
          sort: [{ column: 'id', direction: 'desc' }],
          filters: [{ column: 'status', op: '=', value: 'paid' }],
          limit: 10,
        },
        current,
      ),
    ).toEqual({ sort: [{ column: 'id', direction: 'desc' }], limit: 10 });
  });

  it('is empty when nothing changes, and treats column order as a change', () => {
    expect(trimViewToChanges({ columns: ['id', 'status'], limit: 50 }, current)).toEqual({});
    expect(trimViewToChanges({ columns: ['status', 'id'] }, current)).toEqual({
      columns: ['status', 'id'],
    });
  });

  it('keeps an explicit clear only when something is set', () => {
    expect(trimViewToChanges({ sort: [], filters: [] }, current)).toEqual({
      sort: [],
      filters: [],
    });
    expect(
      trimViewToChanges({ sort: [], filters: [] }, { ...current, sort: [], filters: [] }),
    ).toEqual({});
  });
});
