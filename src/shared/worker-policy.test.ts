import { describe, expect, it } from 'vitest';
import {
  extractCorrelatedId,
  formatStatementTimeoutSql,
  ipcDeadlineMs,
  nextBackoffMs,
} from './worker-policy';

describe('nextBackoffMs', () => {
  it('starts at base when current is 0', () => {
    expect(nextBackoffMs(0)).toBe(250);
  });

  it('doubles until the cap', () => {
    expect(nextBackoffMs(250)).toBe(500);
    expect(nextBackoffMs(500)).toBe(1000);
    expect(nextBackoffMs(8_000)).toBe(10_000);
    expect(nextBackoffMs(10_000)).toBe(10_000);
  });
});

describe('extractCorrelatedId', () => {
  it('returns the string id when present', () => {
    expect(extractCorrelatedId({ id: 'abc-123', kind: 'nope' })).toBe('abc-123');
  });

  it('returns null for missing or non-string ids', () => {
    expect(extractCorrelatedId(null)).toBeNull();
    expect(extractCorrelatedId({})).toBeNull();
    expect(extractCorrelatedId({ id: 42 })).toBeNull();
    expect(extractCorrelatedId('abc')).toBeNull();
  });
});

describe('ipcDeadlineMs', () => {
  it('leaves SQL ops unbounded at the IPC layer', () => {
    expect(ipcDeadlineMs('query')).toBeNull();
    expect(ipcDeadlineMs('sidebandQuery')).toBeNull();
  });

  it('bounds control-plane ops', () => {
    expect(ipcDeadlineMs('ping')).toBe(5_000);
    expect(ipcDeadlineMs('cancel')).toBe(15_000);
    expect(ipcDeadlineMs('setStatementTimeout')).toBe(15_000);
    expect(ipcDeadlineMs('connect')).toBe(60_000);
  });
});

describe('formatStatementTimeoutSql', () => {
  it('emits a safe integer SET', () => {
    expect(formatStatementTimeoutSql(30_000)).toBe('SET statement_timeout = 30000');
    expect(formatStatementTimeoutSql(0)).toBe('SET statement_timeout = 0');
    expect(formatStatementTimeoutSql(-5)).toBe('SET statement_timeout = 0');
    expect(formatStatementTimeoutSql(12.9)).toBe('SET statement_timeout = 12');
  });
});
