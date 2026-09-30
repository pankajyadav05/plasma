import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ipc', () => ({ ipc: { settings: { set: vi.fn() } } }));

import { armProdGate } from './session-prod-gate';
import {
  clearTabResults,
  createEmptyTab,
  defaultActiveResultIndex,
  mergeNotices,
  resultPatch,
  toggled,
} from './session-tab-model';
import { parseCount } from './session-table-query';
import type { SessionState } from './session-types';

describe('toggled', () => {
  it('adds a missing item and removes a present one without mutating the input', () => {
    const base = new Set(['a']);
    const added = toggled(base, 'b');
    expect([...added]).toEqual(['a', 'b']);
    expect([...toggled(added, 'a')]).toEqual(['b']);
    expect([...base]).toEqual(['a']);
  });
});

describe('parseCount', () => {
  it('parses string and numeric cells, null for garbage', () => {
    expect(parseCount('42')).toBe(42);
    expect(parseCount(7)).toBe(7);
    expect(parseCount('abc')).toBeNull();
    expect(parseCount(undefined)).toBeNull();
  });
});

describe('result helpers', () => {
  const sel = { columns: [{ name: 'a' }], rows: [], rowCount: 0 };
  const ddl = { columns: [], rows: [], rowCount: 0 };
  // biome-ignore lint/suspicious/noExplicitAny: minimal QueryResult stand-ins
  const results = [sel, ddl] as any[];

  it('defaults to the last result that has columns', () => {
    expect(defaultActiveResultIndex(results)).toBe(0);
    expect(defaultActiveResultIndex([ddl, ddl] as never)).toBe(1);
    expect(defaultActiveResultIndex([])).toBe(0);
  });

  it('resultPatch clamps the index and copies the array', () => {
    const p = resultPatch(results, 9);
    expect(p.activeResultIndex).toBe(1);
    expect(p.queryResults).not.toBe(results);
    expect(resultPatch([], 3)).toEqual({
      queryResults: [],
      activeResultIndex: 0,
      queryResult: null,
    });
  });

  it('mergeNotices dedupes by severity|code|message', () => {
    const n = { severity: 'NOTICE', message: 'hi' };
    expect(mergeNotices([n], [{ ...n }, { severity: 'NOTICE', message: 'other' }])).toHaveLength(2);
  });
});

describe('clearTabResults', () => {
  it('resets results per tab with fresh Sets, applying extras', () => {
    const t1 = { ...createEmptyTab(50, 'a'), queryError: 'boom', page: 3, totalRowCount: 9 };
    const t2 = { ...createEmptyTab(50, 'b'), page: 2 };
    let state = { tabs: [t1, t2] } as unknown as SessionState;
    const set = (fn: (s: SessionState) => Partial<SessionState>) => {
      state = { ...state, ...fn(state) };
    };
    clearTabResults(set, { totalRowCount: null });
    expect(state.tabs.map((t) => [t.queryError, t.page, t.totalRowCount])).toEqual([
      [null, 0, null],
      [null, 0, null],
    ]);
    expect(state.tabs[0]!.selectedRows).not.toBe(state.tabs[1]!.selectedRows);
    expect(state.tabs.map((t) => t.title)).toEqual(['a', 'b']);
  });
});

describe('armProdGate', () => {
  it('stamps the live connection generation onto the gate', () => {
    const set = vi.fn();
    armProdGate(set, () => ({ connectionGen: 7 }), {
      sql: 'DELETE FROM t',
      tabId: 't1',
      reason: 'prod',
    });
    expect(set).toHaveBeenCalledWith({
      prodGate: { sql: 'DELETE FROM t', tabId: 't1', reason: 'prod', connectionGen: 7 },
    });
  });
});
