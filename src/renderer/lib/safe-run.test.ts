import { describe, expect, it } from 'vitest';
import {
  alwaysSafeRun,
  formatCountdown,
  isPlainDml,
  isSafeRunnable,
  safeRunThreshold,
  safeRunTimeoutSec,
  safeRunWarning,
  shouldAutoSafeRun,
} from './safe-run';

describe('alwaysSafeRun', () => {
  it('defaults on for prod, off otherwise, and an explicit choice wins', () => {
    expect(alwaysSafeRun({ connectionTags: { a: 'prod' } }, 'a')).toBe(true);
    expect(alwaysSafeRun({ connectionTags: { a: 'staging' } }, 'a')).toBe(false);
    expect(alwaysSafeRun({}, 'a')).toBe(false);
    expect(
      alwaysSafeRun({ connectionTags: { a: 'prod' }, connectionAlwaysSafeRun: { a: false } }, 'a'),
    ).toBe(false);
    expect(alwaysSafeRun({ connectionAlwaysSafeRun: { a: true } }, 'a')).toBe(true);
    expect(alwaysSafeRun({ connectionTags: { a: 'prod' } }, null)).toBe(false);
  });
});

describe('statement classification', () => {
  it('takes the four DML kinds, and write CTEs only for explicit Safe Run', () => {
    for (const sql of [
      'INSERT INTO t VALUES (1)',
      'update t set a = 1',
      'DELETE FROM t',
      'MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE',
    ]) {
      expect(isPlainDml(sql)).toBe(true);
      expect(isSafeRunnable(sql)).toBe(true);
    }
    const cte = 'WITH x AS (SELECT 1) DELETE FROM t';
    expect(isPlainDml(cte)).toBe(false);
    expect(isSafeRunnable(cte)).toBe(true);
    expect(isSafeRunnable('WITH x AS (SELECT 1) SELECT * FROM x')).toBe(false);
    expect(isPlainDml('SELECT 1')).toBe(false);
    expect(isSafeRunnable('DROP TABLE t')).toBe(false);
    expect(isPlainDml('UPDATE t SET a = 1; DELETE FROM t')).toBe(false);
  });
});

describe('shouldAutoSafeRun', () => {
  const base = {
    settings: { connectionTags: { p: 'prod' as const } },
    connectionId: 'p',
    engine: 'postgres',
    readOnly: false,
    sql: 'DELETE FROM t WHERE id = 1',
  };
  it('runs DML through Safe Run on a prod connection', () => {
    expect(shouldAutoSafeRun(base)).toBe(true);
  });
  it('leaves reads, other engines, read-only and opted-out connections alone', () => {
    expect(shouldAutoSafeRun({ ...base, sql: 'SELECT 1' })).toBe(false);
    expect(shouldAutoSafeRun({ ...base, engine: 'redis' })).toBe(false);
    expect(shouldAutoSafeRun({ ...base, readOnly: true })).toBe(false);
    expect(
      shouldAutoSafeRun({
        ...base,
        settings: { connectionTags: { p: 'prod' as const }, connectionAlwaysSafeRun: { p: false } },
      }),
    ).toBe(false);
    expect(shouldAutoSafeRun({ ...base, settings: {}, connectionId: 'x' })).toBe(false);
  });
});

describe('thresholds and warnings', () => {
  it('falls back to defaults', () => {
    expect(safeRunThreshold(undefined)).toBe(1000);
    expect(safeRunThreshold({ safeRunRowThreshold: 50 })).toBe(50);
    expect(safeRunTimeoutSec(undefined)).toBe(300);
    expect(safeRunTimeoutSec({ safeRunTimeoutSec: 90 })).toBe(90);
  });

  it('flags a large write and an estimate miss', () => {
    expect(safeRunWarning(10, 12, 1000).messages).toEqual([]);
    const big = safeRunWarning(5000, 5000, 1000);
    expect(big.large).toBe(true);
    expect(big.estimateMiss).toBe(false);
    const miss = safeRunWarning(500, 2, 1000);
    expect(miss.large).toBe(false);
    expect(miss.estimateMiss).toBe(true);
    expect(miss.messages[0]).toMatch(/expected about 2 rows/);
    expect(safeRunWarning(2000, null, 1000, false).messages[0]).toMatch(/2,000\+/);
  });

  it('does not cry wolf on small counts', () => {
    expect(safeRunWarning(30, 1, 1000).estimateMiss).toBe(false);
  });
});

describe('formatCountdown', () => {
  it('formats m:ss and clamps at zero', () => {
    expect(formatCountdown(299_100)).toBe('5:00');
    expect(formatCountdown(61_000)).toBe('1:01');
    expect(formatCountdown(-5)).toBe('0:00');
  });
});

describe('script helpers', () => {
  it('labels the partial commit and counts pending statements', async () => {
    const { partialCommitLabel, pendingStatementCount, statementsLabel, rowsLabel } = await import(
      './safe-run'
    );
    expect(partialCommitLabel(1)).toBe('Commit 1');
    expect(partialCommitLabel(4)).toBe('Commit 1–4');
    expect(pendingStatementCount({})).toBe(1);
    expect(
      pendingStatementCount({
        steps: [{ status: 'done' }, { status: 'failed' }, { status: 'notRun' }],
      }),
    ).toBe(1);
    expect(statementsLabel(1)).toBe('1 statement');
    expect(statementsLabel(3)).toBe('3 statements');
    expect(rowsLabel(1)).toBe('1 row');
    expect(rowsLabel(1200, false)).toBe('1,200+ rows');
  });

  it('judges the row threshold on the total of a script', async () => {
    const { safeRunWarning } = await import('./safe-run');
    // Three statements of 400 rows each are 1,200 rows in total.
    expect(safeRunWarning(400 * 3, null, 1000).large).toBe(true);
    expect(safeRunWarning(400, null, 1000).large).toBe(false);
  });
});
