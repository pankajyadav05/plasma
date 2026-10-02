import type { QueryResult } from '@shared/protocol';
import { describe, expect, it, vi } from 'vitest';
import { pickDisplayResult, runStatements } from './run-statements';

const res = (n: number, cols = 1): QueryResult =>
  ({
    columns: Array.from({ length: cols }, (_, i) => ({
      name: `c${i}`,
      dataTypeID: 23,
      dataTypeName: 'int4',
    })),
    rows: [[n]],
    rowCount: 1,
    durationMs: 1,
  }) as QueryResult;

describe('runStatements (R-12)', () => {
  it('splits a script and runs each statement separately, quote-aware', async () => {
    const run = vi.fn(async (_sql: string, _maxRows?: number) => res(1));
    const out = await runStatements("SELECT 'a;b'; SELECT 2;", { rowLimit: null, run });
    expect(run.mock.calls.map((c) => c[0])).toEqual(["SELECT 'a;b'", 'SELECT 2']);
    expect(out.results).toHaveLength(2);
    expect(out.results[0]?.sql).toBe("SELECT 'a;b'");
    expect(out.error).toBeUndefined();
  });

  it('passes the row limit to every statement', async () => {
    const run = vi.fn(async (_sql: string, _maxRows?: number) => res(1));
    await runStatements('SELECT 1; SELECT 2', { rowLimit: 100, run });
    expect(run.mock.calls.map((c) => c[1])).toEqual([100, 100]);
  });

  it('stops at the first failure and reports which statement', async () => {
    const run = vi
      .fn<(sql: string, maxRows?: number) => Promise<QueryResult>>()
      .mockResolvedValueOnce(res(1))
      .mockRejectedValueOnce(new Error('boom'));
    const out = await runStatements('SELECT 1; SELECT x; SELECT 3', { rowLimit: null, run });
    expect(run).toHaveBeenCalledTimes(2);
    expect(out.results).toHaveLength(1);
    expect(out.error).toMatchObject({
      message: 'boom',
      statementIndex: 1,
      total: 3,
      sql: 'SELECT x',
    });
  });

  it('refuses statements the driver cannot run without sending them', async () => {
    const run = vi.fn(async (_sql: string, _maxRows?: number) => res(1));
    const out = await runStatements('\\copy t from stdin', { rowLimit: null, run });
    expect(out.error?.message).toBeTruthy();
    expect(run).not.toHaveBeenCalled();
  });

  it('stops between statements when asked to', async () => {
    const run = vi.fn(async (_sql: string, _maxRows?: number) => res(1));
    let calls = 0;
    const out = await runStatements('SELECT 1; SELECT 2', {
      rowLimit: null,
      run,
      shouldStop: () => ++calls > 0,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(out.error?.message).toMatch(/connection changed/);
  });
});

describe('pickDisplayResult', () => {
  it('prefers the last result with columns', () => {
    const a = res(1);
    const b = res(2, 0);
    expect(pickDisplayResult([a, b])).toBe(a);
    expect(pickDisplayResult([])).toBeUndefined();
  });
});
