import { describe, expect, it } from 'vitest';
import {
  buildFieldStatsAggs,
  fieldStatsCardKey,
  fieldStatsTopKey,
  isMissingSqlEndpointError,
  readFieldStat,
} from './opensearch-helpers';

describe('isMissingSqlEndpointError', () => {
  it('is true for a ResponseError-shaped 404 via statusCode', () => {
    expect(isMissingSqlEndpointError({ statusCode: 404, meta: { statusCode: 404 } })).toBe(
      true,
    );
  });

  it('is true when only meta.statusCode is 404', () => {
    expect(isMissingSqlEndpointError({ meta: { statusCode: 404 } })).toBe(true);
  });

  it('is true when body.status is 404 (ES-style ResponseError)', () => {
    expect(
      isMissingSqlEndpointError({ meta: { body: { status: 404 }, statusCode: 200 } }),
    ).toBe(true);
  });

  it('preserves non-404 failures (auth, bad SQL, timeout)', () => {
    expect(isMissingSqlEndpointError({ statusCode: 400, message: 'bad sql' })).toBe(false);
    expect(isMissingSqlEndpointError({ statusCode: 401 })).toBe(false);
    expect(isMissingSqlEndpointError({ statusCode: 403 })).toBe(false);
    expect(isMissingSqlEndpointError({ statusCode: 500 })).toBe(false);
    expect(isMissingSqlEndpointError({ name: 'TimeoutError', message: 'timeout' })).toBe(
      false,
    );
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
