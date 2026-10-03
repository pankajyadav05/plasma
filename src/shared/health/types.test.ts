import { describe, expect, it } from 'vitest';
import {
  classifyHealthError,
  fmtBytes,
  fmtDurationMs,
  quoteIdent,
  rowsToObjects,
  worstStatus,
} from './types';

describe('health types', () => {
  it('picks the worst status', () => {
    expect(worstStatus([])).toBe('ok');
    expect(worstStatus(['ok', 'warn'])).toBe('warn');
    expect(worstStatus(['warn', 'crit', 'unknown'])).toBe('crit');
    expect(worstStatus(['ok', 'unknown'])).toBe('unknown');
  });

  it('formats bytes and durations', () => {
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(1536)).toBe('1.5 KiB');
    expect(fmtBytes(5 * 1024 ** 3)).toBe('5.0 GiB');
    expect(fmtDurationMs(250)).toBe('250 ms');
    expect(fmtDurationMs(90_000)).toBe('1.5 min');
  });

  it('quotes identifiers', () => {
    expect(quoteIdent('a"b')).toBe('"a""b"');
  });

  it('keys rows by column name', () => {
    expect(rowsToObjects({ columns: [{ name: 'a' }, { name: 'b' }], rows: [[1, 2]] })).toEqual([
      { a: 1, b: 2 },
    ]);
  });

  it('classifies privilege, missing and timeout errors', () => {
    expect(classifyHealthError('permission denied for view pg_stat_statements').kind).toBe(
      'privilege',
    );
    expect(classifyHealthError('permission denied for view pg_stat_statements').badge).toBe(
      'needs pg_monitor',
    );
    expect(classifyHealthError('NOPERM this user has no permissions to run the command').kind).toBe(
      'privilege',
    );
    expect(classifyHealthError('relation "pg_stat_statements" does not exist').kind).toBe(
      'missing',
    );
    expect(classifyHealthError('canceling statement due to statement timeout').kind).toBe(
      'timeout',
    );
    expect(classifyHealthError('boom').kind).toBe('other');
  });
});
