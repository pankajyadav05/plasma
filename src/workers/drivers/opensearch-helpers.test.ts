import { describe, expect, it } from 'vitest';
import {
  buildFieldStatsAggs,
  fieldStatsCardKey,
  fieldStatsTopKey,
  isMissingSqlEndpointError,
  planOpenSearchConnection,
  readFieldStat,
} from './opensearch-helpers';

describe('isMissingSqlEndpointError', () => {
  it('is true for a ResponseError-shaped 404 via statusCode', () => {
    expect(isMissingSqlEndpointError({ statusCode: 404, meta: { statusCode: 404 } })).toBe(true);
  });

  it('is true when only meta.statusCode is 404', () => {
    expect(isMissingSqlEndpointError({ meta: { statusCode: 404 } })).toBe(true);
  });

  it('is true when body.status is 404 (ES-style ResponseError)', () => {
    expect(isMissingSqlEndpointError({ meta: { body: { status: 404 }, statusCode: 200 } })).toBe(
      true,
    );
  });

  it('preserves non-404 failures (auth, bad SQL, timeout)', () => {
    expect(isMissingSqlEndpointError({ statusCode: 400, message: 'bad sql' })).toBe(false);
    expect(isMissingSqlEndpointError({ statusCode: 401 })).toBe(false);
    expect(isMissingSqlEndpointError({ statusCode: 403 })).toBe(false);
    expect(isMissingSqlEndpointError({ statusCode: 500 })).toBe(false);
    expect(isMissingSqlEndpointError({ name: 'TimeoutError', message: 'timeout' })).toBe(false);
    expect(isMissingSqlEndpointError(new Error('network down'))).toBe(false);
    expect(isMissingSqlEndpointError(null)).toBe(false);
    expect(isMissingSqlEndpointError(undefined)).toBe(false);
  });
});

describe('buildFieldStatsAggs / readFieldStat', () => {
  it('uses distinct aggregation IDs for colliding field names', () => {
    const fields = ['user.id', 'user_id'];
    const aggs = buildFieldStatsAggs(fields);

    // Lossy sanitize would turn both into user_id — these keys must differ.
    expect(Object.keys(aggs).sort()).toEqual(['card_0', 'card_1', 'top_0', 'top_1']);
    expect(aggs.card_0).toEqual({ cardinality: { field: 'user.id' } });
    expect(aggs.card_1).toEqual({ cardinality: { field: 'user_id' } });
    expect(aggs.top_0).toEqual({ terms: { field: 'user.id', size: 10 } });
    expect(aggs.top_1).toEqual({ terms: { field: 'user_id', size: 10 } });
    expect(fieldStatsCardKey(0)).not.toBe(fieldStatsCardKey(1));
    expect(fieldStatsTopKey(0)).not.toBe(fieldStatsTopKey(1));
  });

  it('maps each field to its own aggregation result', () => {
    const fields = ['user.id', 'user_id'];
    const aggData: Record<string, unknown> = {
      card_0: { value: 10 },
      top_0: { buckets: [{ key: 'a', doc_count: 3 }] },
      card_1: { value: 99.4 },
      top_1: { buckets: [{ key: 'b', doc_count: 7 }] },
    };

    const a = readFieldStat(fields[0]!, 0, aggData, 'keyword');
    const b = readFieldStat(fields[1]!, 1, aggData, 'keyword');

    expect(a).toEqual({
      field: 'user.id',
      type: 'keyword',
      cardinality: 10,
      topValues: [{ value: 'a', count: 3 }],
      isTime: false,
    });
    expect(b).toEqual({
      field: 'user_id',
      type: 'keyword',
      cardinality: 99,
      topValues: [{ value: 'b', count: 7 }],
      isTime: false,
    });
  });

  it('marks date fields as time and tolerates missing agg buckets', () => {
    expect(readFieldStat('@timestamp', 0, {}, 'date')).toEqual({
      field: '@timestamp',
      type: 'date',
      cardinality: null,
      topValues: [],
      isTime: true,
    });
  });
});

import {
  encodeIndexPath,
  flattenMappingProps,
  isNdjsonPath,
  mergeMappingTrees,
  parseTotal,
  prepareSearchBody,
  readMsearchFieldStat,
  resolveAggField,
  responseFromError,
  statsQuery,
} from './opensearch-helpers';

describe('parseTotal (O3)', () => {
  it('keeps the gte relation past the track_total_hits cap', () => {
    expect(parseTotal({ value: 10000, relation: 'gte' })).toEqual({
      total: 10000,
      relation: 'gte',
    });
    expect(parseTotal({ value: 5, relation: 'eq' })).toEqual({ total: 5, relation: 'eq' });
    expect(parseTotal(42)).toEqual({ total: 42, relation: 'eq' });
    expect(parseTotal(undefined)).toEqual({ total: 0, relation: 'eq' });
  });
});

describe('prepareSearchBody', () => {
  it('defaults to match_all with size and exact totals', () => {
    expect(prepareSearchBody('', 20)).toEqual({
      query: { match_all: {} },
      size: 20,
      track_total_hits: true,
    });
  });
  it('keeps explicit size / track_total_hits', () => {
    expect(prepareSearchBody('{"size":3,"track_total_hits":false}', 20)).toEqual({
      size: 3,
      track_total_hits: false,
    });
  });
  it('rejects invalid JSON and non-objects', () => {
    expect(() => prepareSearchBody('{', 1)).toThrow(/invalid query DSL JSON/);
    expect(() => prepareSearchBody('[1]', 1)).toThrow(/must be an object/);
  });
});

describe('mapping helpers (O5)', () => {
  const props = {
    title: { type: 'text', fields: { keyword: { type: 'keyword' } } },
    body: { type: 'text' },
    loc: { type: 'geo_point' },
    user: { properties: { id: { type: 'keyword' } } },
  };
  it('flattens dotted paths with multi-fields', () => {
    const flat = flattenMappingProps(props);
    expect(Object.keys(flat).sort()).toEqual(['body', 'loc', 'title', 'user', 'user.id']);
    expect(flat.title?.multiFields).toEqual([{ name: 'keyword', type: 'keyword' }]);
    expect(flat.user?.type).toBe('object');
  });
  it('resolves aggregatable fields', () => {
    const flat = flattenMappingProps(props);
    expect(resolveAggField('title', flat).field).toBe('title.keyword');
    expect(resolveAggField('body', flat).field).toBeNull();
    expect(resolveAggField('loc', flat).reason).toMatch(/geo_point/);
    expect(resolveAggField('user', flat).field).toBeNull();
    expect(resolveAggField('user.id', flat).field).toBe('user.id');
    expect(resolveAggField('unknown', flat).field).toBe('unknown');
  });
  it('merges indices and flags conflicting types', () => {
    const tree = mergeMappingTrees([
      { a: { type: 'keyword' }, o: { properties: { x: { type: 'long' } } } },
      { a: { type: 'text' }, o: { properties: { y: { type: 'date' } } } },
    ]);
    const a = tree.find((n) => n.name === 'a');
    expect(a?.conflicts).toEqual(['keyword', 'text']);
    expect(tree.find((n) => n.name === 'o')?.children.map((c) => c.name)).toEqual(['x', 'y']);
  });
});

describe('field stats per field (O2)', () => {
  it('reads a successful msearch response', () => {
    const s = readMsearchFieldStat('title', 'text', 'title.keyword', {
      aggregations: { card_0: { value: 3 }, top_0: { buckets: [{ key: 'a', doc_count: 2 }] } },
    });
    expect(s).toMatchObject({ cardinality: 3, aggField: 'title.keyword', error: null });
    expect(s.topValues).toEqual([{ value: 'a', count: 2 }]);
  });
  it('keeps a failing field isolated with its reason', () => {
    const s = readMsearchFieldStat('x', 'keyword', 'x', {
      error: { root_cause: [{ reason: 'boom' }] },
    });
    expect(s).toMatchObject({ cardinality: null, error: 'boom' });
  });
  it('builds the stats query from DSL or query_string', () => {
    expect(statsQuery('{"term":{"a":1}}')).toEqual({ term: { a: 1 } });
    expect(statsQuery(undefined, 'a:1')).toEqual({ query_string: { query: 'a:1' } });
    expect(statsQuery()).toBeNull();
    expect(() => statsQuery('[1]')).toThrow();
  });
});

describe('request helpers (O14)', () => {
  it('encodes index paths but keeps wildcards and lists', () => {
    expect(encodeIndexPath('logs-*,events')).toBe('logs-*,events');
    expect(encodeIndexPath('a b')).toBe('a%20b');
  });
  it('detects NDJSON endpoints', () => {
    expect(isNdjsonPath('/_bulk')).toBe(true);
    expect(isNdjsonPath('/idx/_bulk?refresh=true')).toBe(true);
    expect(isNdjsonPath('/_msearch')).toBe(true);
    expect(isNdjsonPath('/idx/_search')).toBe(false);
  });
  it('extracts HTTP errors but not transport errors', () => {
    expect(responseFromError({ meta: { statusCode: 404, body: { found: false } } })).toEqual({
      status: 404,
      body: { found: false },
    });
    expect(responseFromError(new Error('ECONNREFUSED'))).toBeNull();
  });
});

describe('planOpenSearchConnection (O12)', () => {
  const base = { host: 'search.example.com', port: 9200, ssl: true };
  it('defaults to one node with basic auth from user/password', () => {
    expect(planOpenSearchConnection({ ...base, user: 'u', password: 'p' })).toEqual({
      nodes: ['https://search.example.com:9200'],
      basic: { username: 'u', password: 'p' },
      headers: {},
    });
    expect(planOpenSearchConnection(base).basic).toBeUndefined();
  });
  it('applies the path prefix and extra nodes (deduplicated)', () => {
    const plan = planOpenSearchConnection({
      ...base,
      opensearch: {
        pathPrefix: 'search/',
        nodes: ['b.example.com:9200', 'https://c:9200/other', 'b.example.com:9200'],
      },
    });
    expect(plan.nodes).toEqual([
      'https://search.example.com:9200/search',
      'https://b.example.com:9200/search',
      'https://c:9200/other',
    ]);
  });
  it('sends an API key as an Authorization header, encoding id:key', () => {
    const plan = planOpenSearchConnection({
      ...base,
      user: 'ignored',
      opensearch: { auth: 'apiKey', apiKey: 'id:secret' },
    });
    expect(plan.headers.Authorization).toBe(
      `ApiKey ${Buffer.from('id:secret').toString('base64')}`,
    );
    expect(plan.basic).toBeUndefined();
    expect(
      planOpenSearchConnection({ ...base, opensearch: { auth: 'apiKey', apiKey: 'ZW5jb2RlZA==' } })
        .headers.Authorization,
    ).toBe('ApiKey ZW5jb2RlZA==');
  });
  it('builds SigV4 credentials and validates required fields', () => {
    const plan = planOpenSearchConnection({
      ...base,
      opensearch: {
        auth: 'sigv4',
        awsRegion: 'eu-west-1',
        awsService: 'aoss',
        awsAccessKeyId: 'AKIA',
        awsSecretAccessKey: 'sec',
        awsSessionToken: 'tok',
      },
    });
    expect(plan.sigv4).toEqual({
      region: 'eu-west-1',
      service: 'aoss',
      credentials: { accessKeyId: 'AKIA', secretAccessKey: 'sec', sessionToken: 'tok' },
    });
    expect(() => planOpenSearchConnection({ ...base, opensearch: { auth: 'sigv4' } })).toThrow(
      /region/,
    );
    expect(() =>
      planOpenSearchConnection({ ...base, opensearch: { auth: 'apiKey', apiKey: ' ' } }),
    ).toThrow(/API key/);
  });
});
