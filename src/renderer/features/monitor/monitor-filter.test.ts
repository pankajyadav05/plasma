import type { ActivityRow } from '@shared/protocol';
import { describe, expect, it } from 'vitest';
import { filterActivity, isPlasmaSession, killSucceeded } from './monitor-filter';

function row(p: Partial<ActivityRow>): ActivityRow {
  return {
    pid: 1,
    state: 'active',
    user: 'app',
    database: 'db1',
    applicationName: 'psql',
    clientAddr: null,
    backendStart: null,
    queryStart: null,
    stateChange: null,
    waitEventType: null,
    waitEvent: null,
    query: 'select 1',
    durationMs: null,
    isCurrent: false,
    ...p,
  } as ActivityRow;
}

const base = { showIdle: true, showSelf: false, search: '', database: null };

describe('filterActivity', () => {
  const rows = [
    row({ pid: 1 }),
    row({ pid: 2, state: 'idle', database: 'db2' }),
    row({ pid: 3, isCurrent: true }),
    row({ pid: 4, query: 'UPDATE orders SET x = 1', user: 'batch' }),
  ];
  it('hides the monitor backend and idle sessions on request', () => {
    expect(filterActivity(rows, base).map((r) => r.pid)).toEqual([1, 2, 4]);
    expect(filterActivity(rows, { ...base, showIdle: false }).map((r) => r.pid)).toEqual([1, 4]);
    expect(filterActivity(rows, { ...base, showSelf: true })).toHaveLength(4);
  });
  it('filters by database and search text', () => {
    expect(filterActivity(rows, { ...base, database: 'db2' }).map((r) => r.pid)).toEqual([2]);
    expect(filterActivity(rows, { ...base, search: 'orders' }).map((r) => r.pid)).toEqual([4]);
    expect(filterActivity(rows, { ...base, search: 'BATCH' }).map((r) => r.pid)).toEqual([4]);
    expect(filterActivity(rows, { ...base, search: '2' }).map((r) => r.pid)).toEqual([2]);
  });
});

describe('isPlasmaSession / killSucceeded', () => {
  it('recognises Plasma connections', () => {
    expect(isPlasmaSession({ applicationName: 'plasma-aux' })).toBe(true);
    expect(isPlasmaSession({ applicationName: 'psql' })).toBe(false);
    expect(isPlasmaSession({ applicationName: null })).toBe(false);
  });
  it('treats a false result as failure', () => {
    expect(killSucceeded([[true]])).toBe(true);
    expect(killSucceeded([[false]])).toBe(false);
    expect(killSucceeded([])).toBe(false);
  });
});
