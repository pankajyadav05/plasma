import { describe, expect, it } from 'vitest';
import {
  assertOsWritable,
  parseOsRequestArgs,
  parseOsSearchArgs,
  parseOsSqlArgs,
} from './opensearch-ipc';

describe('OpenSearch IPC write gating (S1/O1)', () => {
  it('blocks create/delete index on read-only sessions', () => {
    expect(() => assertOsWritable(true)).toThrow(/read-only/);
    expect(() => assertOsWritable(false)).not.toThrow();
  });

  it('lets reads through the console on read-only sessions', () => {
    expect(parseOsRequestArgs({ method: 'get', path: '_cat/indices' }, true)).toMatchObject({
      method: 'GET',
      path: '_cat/indices',
    });
    expect(
      parseOsRequestArgs({ method: 'POST', path: '/events/_search', body: '{}' }, true).body,
    ).toBe('{}');
  });

  it('refuses console writes on read-only sessions only', () => {
    const del = { method: 'DELETE', path: '/events' };
    expect(() => parseOsRequestArgs(del, true)).toThrow(/read-only/);
    expect(parseOsRequestArgs(del, false).method).toBe('DELETE');
    expect(() =>
      parseOsRequestArgs({ method: 'PUT', path: '/events/_doc/1', body: '{}' }, true),
    ).toThrow(/read-only/);
  });

  it('rejects bad methods and absolute URLs', () => {
    expect(() => parseOsRequestArgs({ method: 'TRACE', path: '/' }, false)).toThrow(/method/);
    expect(() =>
      parseOsRequestArgs({ method: 'GET', path: 'http://evil.example/' }, false),
    ).toThrow(/relative/);
    expect(() => parseOsRequestArgs({ method: 'GET', path: '  ' }, false)).toThrow(/path/);
  });

  it('gates SQL writes and accepts the legacy string form', () => {
    expect(parseOsSqlArgs('SELECT 1', true).query).toBe('SELECT 1');
    expect(() => parseOsSqlArgs('DELETE FROM t', true)).toThrow(/read-only/);
    expect(parseOsSqlArgs('DELETE FROM t', false).query).toBe('DELETE FROM t');
    expect(parseOsSqlArgs({ query: '', cursor: 'abc' }, true)).toMatchObject({
      query: '',
      cursor: 'abc',
    });
    expect(() => parseOsSqlArgs({ query: ' ' }, false)).toThrow(/query required/);
  });

  it('clamps search size and passes timeout/request ids through', () => {
    expect(
      parseOsSearchArgs({ index: 'a', body: '', size: 50_000, timeoutMs: 5000, requestId: 'r' }),
    ).toEqual({ index: 'a', body: '', size: 10_000, timeoutMs: 5000, requestId: 'r' });
    expect(parseOsSearchArgs({ index: 'a', body: '', timeoutMs: -1 }).timeoutMs).toBeUndefined();
    expect(() => parseOsSearchArgs({ index: 'a' })).toThrow(/body/);
  });
});
