import { describe, expect, it } from 'vitest';
import {
  assertRedisCommandAllowed,
  clampAnalyzeSample,
  parseRedisBulkDeleteArgs,
  parseRedisCommandArgs,
  parseRedisGetKeyArgs,
  parseRedisPatternDeleteArgs,
  parseRedisWriteArgs,
} from './redis-ipc-args';

describe('redis IPC args', () => {
  it('accepts legacy and object payloads', () => {
    expect(parseRedisGetKeyArgs('k')).toEqual({ key: 'k' });
    expect(parseRedisGetKeyArgs({ key: 'k', opts: { db: 3, cursor: '10', count: 9999 } })).toEqual({
      key: 'k',
      opts: { db: 3, cursor: '10', count: 5000 },
    });
    expect(parseRedisCommandArgs(['GET', 'k'])).toEqual({ parts: ['GET', 'k'], db: undefined });
    expect(parseRedisCommandArgs({ parts: ['GET', 'k'], db: 2 })).toEqual({
      parts: ['GET', 'k'],
      db: 2,
    });
    expect(parseRedisBulkDeleteArgs({ keys: ['a'], db: 1 })).toEqual({ keys: ['a'], db: 1 });
    expect(parseRedisWriteArgs({ kind: 'setString', key: 'a', value: 'b' }).op.kind).toBe(
      'setString',
    );
    expect(parseRedisWriteArgs({ op: { kind: 'hashDel', key: 'a', field: 'f' }, db: 4 }).db).toBe(
      4,
    );
  });

  it('pattern delete defaults to a dry run', () => {
    expect(parseRedisPatternDeleteArgs({ match: 'a*' }).dryRun).toBe(true);
    expect(parseRedisPatternDeleteArgs({ match: 'a*', dryRun: false }).dryRun).toBe(false);
    expect(() => parseRedisPatternDeleteArgs({})).toThrow();
  });

  it('clamps the analyzer sample (R14)', () => {
    expect(clampAnalyzeSample(undefined)).toBe(5000);
    expect(clampAnalyzeSample(10_000_000)).toBe(50_000);
  });

  it('blocks write commands on read-only connections (S1)', () => {
    expect(() => assertRedisCommandAllowed(['SET', 'a', 'b'], true)).toThrow(/read-only/);
    expect(() => assertRedisCommandAllowed(['FLUSHALL'], true)).toThrow(/read-only/);
    expect(() => assertRedisCommandAllowed(['GET', 'a'], true)).not.toThrow();
    expect(() => assertRedisCommandAllowed(['SET', 'a', 'b'], false)).not.toThrow();
  });
});
