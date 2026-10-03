import { describe, expect, it } from 'vitest';
import { redisEndpointKind, sshUnsupportedReason } from './connection-endpoint';

describe('redisEndpointKind', () => {
  it('classifies host forms', () => {
    expect(redisEndpointKind('localhost')).toBe('tcp');
    expect(redisEndpointKind('/var/run/redis.sock')).toBe('unix');
    expect(redisEndpointKind('unix:/tmp/r.sock')).toBe('unix');
    expect(redisEndpointKind(' sentinel://h:26379/main')).toBe('sentinel');
    expect(redisEndpointKind('CLUSTER://h:7000')).toBe('cluster');
  });
});

describe('sshUnsupportedReason', () => {
  it('refuses tunnels for socket, sentinel and cluster endpoints', () => {
    for (const host of ['/tmp/r.sock', 'sentinel://h:1/m', 'cluster://h:1']) {
      expect(sshUnsupportedReason({ engine: 'redis', host })).toMatch(/SSH tunnel/);
    }
  });
  it('allows plain TCP redis and postgres', () => {
    expect(sshUnsupportedReason({ engine: 'redis', host: 'cache.internal' })).toBeNull();
    expect(sshUnsupportedReason({ engine: 'postgres', host: '/var/run/postgresql' })).toBeNull();
  });
  it('refuses a tunnel for local DuckDB files but allows ClickHouse', () => {
    expect(sshUnsupportedReason({ engine: 'duckdb', host: 'local' })).toMatch(/nothing to tunnel/);
    expect(sshUnsupportedReason({ engine: 'clickhouse', host: 'ch.internal' })).toBeNull();
  });
});
