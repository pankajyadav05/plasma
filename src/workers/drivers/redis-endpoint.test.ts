import { describe, expect, it } from 'vitest';
import { parseRedisEndpoint } from './redis-endpoint';

describe('parseRedisEndpoint (R19)', () => {
  it('plain host', () => {
    expect(parseRedisEndpoint('localhost', 6379)).toEqual({
      kind: 'tcp',
      host: 'localhost',
      port: 6379,
    });
  });
  it('unix sockets', () => {
    expect(parseRedisEndpoint('/tmp/r.sock', 0)).toEqual({ kind: 'socket', path: '/tmp/r.sock' });
    expect(parseRedisEndpoint('unix:/tmp/r.sock', 0)).toEqual({
      kind: 'socket',
      path: '/tmp/r.sock',
    });
  });
  it('sentinel with and without auth', () => {
    expect(parseRedisEndpoint('sentinel://a:26380,b/mymaster', 6379)).toEqual({
      kind: 'sentinel',
      sentinels: [
        { host: 'a', port: 26380 },
        { host: 'b', port: 26379 },
      ],
      name: 'mymaster',
      sentinelUsername: undefined,
      sentinelPassword: undefined,
    });
    const s = parseRedisEndpoint('sentinel://u:p%40ss@a/m', 6379);
    expect(s).toMatchObject({ sentinelUsername: 'u', sentinelPassword: 'p@ss', name: 'm' });
    expect(() => parseRedisEndpoint('sentinel://a:26379', 6379)).toThrow(/master-name/);
  });
  it('cluster seeds', () => {
    expect(parseRedisEndpoint('cluster://a:7000,[::1]:7001', 6379)).toEqual({
      kind: 'cluster',
      nodes: [
        { host: 'a', port: 7000 },
        { host: '::1', port: 7001 },
      ],
    });
  });
});
