import { describe, expect, it } from 'vitest';
import { isOsReadRequest, isReadOnlyOsSql, osPathSegments } from './os-write-policy';

describe('osPathSegments', () => {
  it('drops the query string and empty parts', () => {
    expect(osPathSegments('/logs-*/_search?size=1')).toEqual(['logs-*', '_search']);
    expect(osPathSegments('_cat/indices')).toEqual(['_cat', 'indices']);
  });
});

describe('isReadOnlyOsSql', () => {
  it.each([
    'SELECT * FROM events',
    '  select 1',
    '/* c */ SHOW TABLES LIKE %',
    'DESCRIBE TABLES LIKE events',
    'EXPLAIN SELECT 1',
    'SELECT 1;',
    "SELECT * FROM t WHERE a = 'x;y'",
  ])('allows %s', (sql) => {
    expect(isReadOnlyOsSql(sql)).toBe(true);
  });

  it.each([
    'DELETE FROM events WHERE 1=1',
    'UPDATE t SET a = 1',
    'SELECT 1; DELETE FROM t',
    '',
    '-- only a comment',
  ])('blocks %s', (sql) => {
    expect(isReadOnlyOsSql(sql)).toBe(false);
  });
});

describe('isOsReadRequest', () => {
  const cases: Array<[string, string, unknown, boolean]> = [
    ['GET', '/_cat/indices', undefined, true],
    ['HEAD', '/events', undefined, true],
    ['GET', '/events/_doc/1', undefined, true],
    ['POST', '/events/_search', '{}', true],
    ['POST', '/_search/scroll', '{}', true],
    ['POST', '/events/_count', undefined, true],
    ['POST', '/events/_explain/1', '{}', true],
    ['POST', '/_mget', '{}', true],
    ['POST', '/events/_validate/query', '{}', true],
    ['POST', '/_plugins/_sql', '{"query":"SELECT * FROM events"}', true],
    ['POST', '/_plugins/_sql', { query: 'SHOW TABLES LIKE %' }, true],
    ['POST', '/_plugins/_sql', '{"cursor":"abc"}', true],
    ['POST', '/_plugins/_sql', '{"query":"DELETE FROM events"}', false],
    ['POST', '/_plugins/_sql', 'not json', false],
    ['POST', '/_plugins/_ppl', '{"query":"source=events"}', true],
    ['POST', '/_plugins/_sql/_explain', '{"query":"SELECT 1"}', true],
    ['DELETE', '/_search/scroll', undefined, true],
    ['POST', '/_cluster/allocation/explain', '{}', true],
    ['DELETE', '/events', undefined, false],
    ['DELETE', '/events/_doc/1', undefined, false],
    ['PUT', '/events', '{}', false],
    ['PUT', '/events/_doc/1', '{}', false],
    ['POST', '/events/_doc', '{}', false],
    ['POST', '/events/_update/1', '{}', false],
    ['POST', '/events/_delete_by_query', '{}', false],
    ['POST', '/events/_update_by_query', '{}', false],
    ['POST', '/_bulk', '', false],
    ['POST', '/events/_close', undefined, false],
    ['POST', '/events/_refresh', undefined, false],
    ['POST', '/_reindex', '{}', false],
    ['POST', '/_aliases', '{}', false],
    ['POST', '/_tasks/abc:1/_cancel', undefined, false],
    ['PATCH', '/x', undefined, false],
    ['OPTIONS', '/', undefined, false],
  ];
  it.each(cases)('%s %s → read=%s', (method, path, body, read) => {
    expect(isOsReadRequest(method, path, body)).toBe(read);
  });

  it('does not treat an index literally named _search-like as read on PUT', () => {
    expect(isOsReadRequest('PUT', '/_search', '{}')).toBe(false);
  });
});
