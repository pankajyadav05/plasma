import { describe, expect, it } from 'vitest';
import { parseInfo } from './redis';

// Shape of real `INFO` output (Redis 7.2): starts with "# Server", CRLF lines.
const INFO = [
  '# Server',
  'redis_version:7.2.5',
  'redis_mode:standalone',
  'os:Linux 6.8.0 x86_64',
  'executable:/opt/redis:bin/redis-server',
  '',
  '# Clients',
  'connected_clients:3',
  '',
  '# Memory',
  'used_memory:1048576',
  'used_memory_human:1.00M',
  'maxmemory:0',
  'maxmemory_human:0B',
  '',
  '# Replication',
  'role:master',
  'connected_slaves:0',
  '',
  '# Keyspace',
  'db0:keys=1208,expires=800,avg_ttl=2104000',
  '',
].join('\r\n');

describe('parseInfo', () => {
  it('reads the leading Server section (version, mode)', () => {
    const p = parseInfo(INFO);
    expect(p.serverFields.redis_version).toBe('7.2.5');
    expect(p.serverFields.redis_mode).toBe('standalone');
  });

  it('reads later sections too', () => {
    const p = parseInfo(INFO);
    expect(p.replicationFields.role).toBe('master');
    expect(p.keyspaceLines).toEqual(['db0:keys=1208,expires=800,avg_ttl=2104000']);
  });

  it('reads memory and clients, and keeps colons inside values', () => {
    const p = parseInfo(INFO);
    expect(p.memoryFields.used_memory_human).toBe('1.00M');
    expect(p.clientFields.connected_clients).toBe('3');
    expect(p.serverFields.executable).toBe('/opt/redis:bin/redis-server');
  });
});
