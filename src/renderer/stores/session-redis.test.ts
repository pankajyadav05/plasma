import type { RedisScanResult } from '@shared/protocol';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ipc', () => ({ ipc: { redis: {} } }));

import { mergeScanPages, parseRedisDb, redisConnectReset } from './session-redis';

const page = (keys: string[], cursor = '0'): RedisScanResult => ({
  cursor,
  keys: keys.map((key) => ({ key, type: 'string', ttlMs: null, sizeBytes: null })),
  scanned: keys.length,
});

describe('session-redis', () => {
  it('merges scan pages without duplicates (R30)', () => {
    const merged = mergeScanPages(
      mergeScanPages(null, page(['a', 'b', 'a'], '5')),
      page(['b', 'c']),
    );
    expect(merged.keys.map((k) => k.key)).toEqual(['a', 'b', 'c']);
    expect(merged.cursor).toBe('0');
  });

  it('resets edit mode, bulk selection and db on connect (R2/R6/R20)', () => {
    const p = redisConnectReset({ engine: 'redis', database: '3' });
    expect(p.editMode).toBe(false);
    expect(p.redisBulkMode).toBe(false);
    expect(p.selectedRedisKeys.size).toBe(0);
    expect(p.redisDb).toBe(3);
    expect(redisConnectReset({ engine: 'postgres', database: 'app' }).redisDb).toBe(0);
    expect(parseRedisDb('x')).toBe(0);
  });
});
