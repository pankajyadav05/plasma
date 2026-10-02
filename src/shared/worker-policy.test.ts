import { describe, expect, it } from 'vitest';
import {
  cancelRequestFor,
  extractCorrelatedId,
  formatStatementTimeoutSql,
  holdsExclusiveLane,
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

  it('leaves file exports unbounded so main never gives up mid-write (C30)', () => {
    expect(ipcDeadlineMs('exportQuery')).toBeNull();
    expect(ipcDeadlineMs('exportRows')).toBeNull();
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

describe('long-job deadlines (SC-06)', () => {
  it('has no blanket deadline for imports, DDL, explain, edit batches and bulk Redis work', () => {
    for (const kind of [
      'importRun',
      'applyDdl',
      'explain',
      'commitEditBatch',
      'redisBulkDelete',
      'redisDeleteByPattern',
      'redisAnalyze',
    ] as const) {
      expect(ipcDeadlineMs(kind)).toBeNull();
    }
  });

  it('derives the OpenSearch deadline from the request timeout', () => {
    const req = {
      kind: 'osRequest',
      id: 'x',
      method: 'GET',
      path: '/',
      timeoutMs: 600_000,
    } as const;
    expect(ipcDeadlineMs('osRequest', req)).toBe(610_000);
    expect(ipcDeadlineMs('osRequest', { ...req, timeoutMs: 0 })).toBe(120_000);
  });

  it('maps a timed-out request to the message that stops its worker-side work', () => {
    expect(cancelRequestFor({ kind: 'aiQuery', id: 'a', sql: 'select 1' }, 'c1')).toEqual({
      kind: 'cancel',
      id: 'c1',
    });
    expect(
      cancelRequestFor(
        { kind: 'osSearch', id: 'a', index: 'i', body: '{}', size: 10, requestId: 'r1' },
        'c2',
      ),
    ).toEqual({ kind: 'osCancel', id: 'c2', requestId: 'r1' });
    expect(cancelRequestFor({ kind: 'ping', id: 'p' } as never, 'c3')).toBeNull();
  });

  it('knows which requests hold an exclusive lane', () => {
    expect(holdsExclusiveLane('importRun')).toBe(true);
    expect(holdsExclusiveLane('osSearch')).toBe(false);
  });
});
