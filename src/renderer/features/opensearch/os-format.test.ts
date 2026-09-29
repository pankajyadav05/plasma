import type { OsSearchResult } from '@shared/protocol';
import { describe, expect, it } from 'vitest';
import {
  buildDiscoverBody,
  displayValue,
  flattenAggregations,
  geoText,
  getPath,
  groupIndices,
  hitsToCsv,
  mappingLeafFields,
  nextPageCursor,
  pageBody,
  pickDefaultColumns,
  queryOfBody,
  sortPath,
  totalLabel,
} from './os-format';

describe('values', () => {
  it('reads dotted paths through objects, literal keys and arrays', () => {
    expect(getPath({ user: { id: 'u1' } }, 'user.id')).toBe('u1');
    expect(getPath({ 'user.id': 'u2' }, 'user.id')).toBe('u2');
    expect(getPath({ tags: [{ n: 'a' }, { n: 'b' }] }, 'tags.n')).toEqual(['a', 'b']);
    expect(getPath({}, 'x.y')).toBeUndefined();
  });

  it('renders geo points as "lat, lon" (F39)', () => {
    expect(geoText({ lat: 1.5, lon: 2 })).toBe('1.5, 2');
    expect(geoText([2, 1.5])).toBe('1.5, 2');
    expect(displayValue({ lat: 1, lon: 2 }, 'geo_point')).toBe('1, 2');
    expect(displayValue({ lat: 1, lon: 2 })).toBe('1, 2');
  });

  it('renders objects compactly and scalar arrays joined (O22)', () => {
    expect(displayValue({ a: 1, b: 'x' })).toBe('{a: 1, b: "x"}');
    expect(displayValue(['a', 'b'])).toBe('a, b');
    expect(displayValue(null)).toBeNull();
  });

  it('labels totals past the cap', () => {
    expect(totalLabel({ total: 10000, totalRelation: 'gte' })).toBe('≥ 10,000');
    expect(totalLabel({ total: 12, totalRelation: 'eq' })).toBe('12');
  });
});

describe('mapping + columns', () => {
  const leaves = mappingLeafFields([
    { name: 'title', type: 'text', children: [], multiFields: [{ name: 'kw', type: 'keyword' }] },
    { name: 'user', type: 'object', children: [{ name: 'id', type: 'keyword', children: [] }] },
    { name: 'n', type: 'long', children: [], conflicts: ['long', 'keyword'] },
  ]);

  it('flattens to leaf paths with keyword sub-fields and conflicts (O5)', () => {
    expect(leaves.map((l) => l.path)).toEqual(['title', 'user.id', 'n']);
    expect(leaves[0]?.keyword).toBe('title.kw');
    expect(leaves[2]?.conflicts).toEqual(['long', 'keyword']);
  });

  it('shows text fields by default (F39)', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      path: `f${i}`,
      type: i === 11 ? 'text' : 'long',
      keyword: null,
      conflicts: null,
    }));
    expect(pickDefaultColumns(many, 3)).toEqual(['f11', 'f0', 'f1']);
    expect(pickDefaultColumns(leaves)).toEqual(['title', 'user.id', 'n']);
  });

  it('sorts text via its keyword sub-field', () => {
    expect(sortPath(leaves[0], 'title')).toBe('title.kw');
    expect(sortPath(leaves[1], 'user.id')).toBe('user.id');
  });
});

describe('bodies + paging (O3)', () => {
  it('builds a discover body with a tiebreak sort and time filter', () => {
    const b = buildDiscoverBody({
      queryString: 'a:1',
      size: 50,
      sort: { field: 'ts', dir: 'desc' },
      timeField: 'ts',
      timeRange: 'now-1h',
    });
    expect(b.sort).toEqual([{ ts: { order: 'desc' } }, { _doc: 'asc' }]);
    expect(b.query).toEqual({
      bool: {
        filter: [
          { query_string: { query: 'a:1' } },
          { range: { ts: { gte: 'now-1h', lte: 'now' } } },
        ],
      },
    });
    expect(
      buildDiscoverBody({ queryString: '', size: 5, sort: null, timeField: null, timeRange: null })
        .query,
    ).toEqual({ match_all: {} });
  });

  const hit = (i: number, sort?: unknown[]) => ({
    index: 'x',
    id: String(i),
    score: null,
    source: {},
    ...(sort ? { sort } : {}),
  });
  const result = (hits: ReturnType<typeof hit>[], total: number): OsSearchResult => ({
    total,
    totalRelation: 'eq',
    took: 1,
    hits,
    aggregations: null,
    fields: [],
  });

  it('prefers search_after, falls back to from inside the window', () => {
    expect(nextPageCursor(result([hit(1), hit(2, [9])], 10), 0, 2)).toEqual({ searchAfter: [9] });
    expect(nextPageCursor(result([hit(1), hit(2)], 10), 0, 2)).toEqual({ from: 2 });
    expect(nextPageCursor(result([hit(1), hit(2)], 2), 0, 2)).toBeNull();
    expect(nextPageCursor(result([hit(1)], 10), 0, 2)).toBeNull();
    expect(nextPageCursor(result([hit(1), hit(2)], 50_000), 4999, 2)).toBeNull();
  });

  it('re-issues the base body at a cursor', () => {
    expect(JSON.parse(pageBody('{"size":2,"from":4}', { searchAfter: [1] }))).toEqual({
      size: 2,
      search_after: [1],
    });
    expect(JSON.parse(pageBody('{"size":2}', { from: 6 }))).toEqual({ size: 2, from: 6 });
  });

  it('extracts the DSL query for field stats', () => {
    expect(queryOfBody('{"query":{"term":{"a":1}}}')).toBe('{"term":{"a":1}}');
    expect(queryOfBody('nope')).toBeUndefined();
  });
});

describe('flattenAggregations (O4)', () => {
  it('flattens buckets, nested sub-aggs and metrics', () => {
    const rows = flattenAggregations({
      by_country: {
        buckets: [
          {
            key: 'JP',
            doc_count: 3,
            avg_risk: { value: 1.5 },
            by_sev: { buckets: [{ key: 'high', doc_count: 2 }] },
          },
        ],
      },
      total: { value: 42 },
      only_high: { doc_count: 7, inner_max: { value: 9 } },
    });
    expect(rows).toEqual([
      { path: 'by_country', key: 'JP', docCount: 3, value: 'avg_risk: 1.5', depth: 0 },
      { path: 'by_country [JP] › by_sev', key: 'high', docCount: 2, value: null, depth: 1 },
      { path: 'total', key: null, docCount: null, value: '42', depth: 0 },
      { path: 'only_high', key: null, docCount: 7, value: null, depth: 0 },
      { path: 'only_high › inner_max', key: null, docCount: null, value: '9', depth: 1 },
    ]);
  });
});

describe('export + grouping', () => {
  it('writes CSV with quoting', () => {
    const csv = hitsToCsv(
      [{ index: 'i', id: '1', score: null, source: { a: 'x,y', b: { lat: 1, lon: 2 } } }],
      ['a', 'b'],
    );
    expect(csv).toBe('_index,_id,a,b\ni,1,"x,y","1, 2"');
  });

  it('groups rolling and data-stream indices (O24)', () => {
    const out = groupIndices([
      'events',
      'logs-2026.09.01',
      'logs-2026.09.02',
      'logs-2026.09.03',
      'metrics-2026.09.01',
      '.ds-app-000001',
      '.ds-app-000002',
      '.ds-app-000003',
    ]);
    expect(out).toEqual([
      'events',
      { name: 'logs-*', members: ['logs-2026.09.01', 'logs-2026.09.02', 'logs-2026.09.03'] },
      'metrics-2026.09.01',
      {
        name: 'app (data stream)',
        members: ['.ds-app-000001', '.ds-app-000002', '.ds-app-000003'],
      },
    ]);
  });
});

import { isDestructiveRequest } from './os-format';

describe('isDestructiveRequest', () => {
  it('flags deletes and index-offline operations', () => {
    expect(isDestructiveRequest('DELETE', '/events')).toBe(true);
    expect(isDestructiveRequest('POST', '/events/_delete_by_query')).toBe(true);
    expect(isDestructiveRequest('POST', 'events/_close')).toBe(true);
    expect(isDestructiveRequest('PUT', '/events/_doc/1')).toBe(false);
    expect(isDestructiveRequest('POST', '/events/_refresh')).toBe(false);
  });
});
