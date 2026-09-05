import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryRun = vi.fn();

vi.mock('@/lib/ipc', () => ({
  ipc: {
    query: {
      run: (...args: unknown[]) => queryRun(...args),
      cancel: vi.fn(async () => undefined),
    },
    sql: { format: vi.fn() },
    conn: {
      test: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      list: vi.fn(async () => []),
      get: vi.fn(),
      delete: vi.fn(),
    },
    schema: { introspect: vi.fn() },
    settings: { get: vi.fn(), set: vi.fn(async () => undefined) },
    history: { list: vi.fn(async () => []), clear: vi.fn() },
    txn: { begin: vi.fn(), commit: vi.fn(), rollback: vi.fn() },
    ai: { ask: vi.fn(), cancel: vi.fn() },
  },
}));

import { useSession } from './session';

const sampleResult = {
  columns: [{ name: 'n', dataTypeId: 23 }],
  rows: [[1]],
  rowCount: 1,
  command: 'SELECT',
  durationMs: 1,
};

function resetStore() {
  const pageSize = useSession.getState().settings.defaultPageSize;
  useSession.setState({
    activeConfig: {
      id: 'conn-prod',
      name: 'prod-db',
      engine: 'postgres',
      host: 'localhost',
      port: 5432,
      database: 'app',
      user: 'u',
      password: '',
      ssl: false,
    },
    connectionState: 'connected',
    settings: {
      ...useSession.getState().settings,
      connectionTags: { 'conn-prod': 'prod' },
    },
    prodGate: null,
    tabs: [
      {
        id: 'tab-a',
        title: 'a.sql',
        kind: 'sql',
        sql: 'DELETE FROM users;',
        queryRunState: 'idle',
        queryResult: null,
        queryError: null,
        queryErrorSql: null,
        page: 0,
        pageSize,
        sortColumn: null,
        selectedCell: null,
        selectedRows: new Set(),
        columnWidths: {},
        tableSort: [],
        filters: [],
        hiddenColumns: new Set(),
        stickyColumns: new Set(),
        totalRowCount: null,
        totalRowCountIsEstimate: false,
        countLoading: false,
        viewMode: 'data',
        rlsPolicyCount: null,
      },
    ],
    activeTabId: 'tab-a',
  });
}

describe('prod gate (U11)', () => {
  beforeEach(() => {
    queryRun.mockReset();
    queryRun.mockResolvedValue(sampleResult);
    resetStore();
  });

  it('stashes a one-use {sql, tabId, connectionGen} without running', async () => {
    await useSession.getState().runQuery();
    const gate = useSession.getState().prodGate;
    expect(gate).toEqual({
      sql: 'DELETE FROM users;',
      tabId: 'tab-a',
      connectionGen: 0,
    });
    expect(queryRun).not.toHaveBeenCalled();
  });

  it('confirm executes the captured payload once and does not re-open the gate', async () => {
    await useSession.getState().runQuery();
    expect(useSession.getState().prodGate).not.toBeNull();

    useSession.getState().confirmProdGate();
    // confirmProdGate fires runQuery without awaiting — flush microtasks.
    await vi.waitFor(() => {
      expect(queryRun).toHaveBeenCalledTimes(1);
    });
    expect(queryRun).toHaveBeenCalledWith('DELETE FROM users');
    expect(useSession.getState().prodGate).toBeNull();
    expect(useSession.getState().tabs[0]?.queryResult).toEqual(sampleResult);
  });

  it('confirm still runs the captured SQL even if the tab text changed', async () => {
    await useSession.getState().runQuery();
    useSession.setState((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === 'tab-a' ? { ...t, sql: 'DELETE FROM other;' } : t,
      ),
    }));
    useSession.getState().confirmProdGate();
    await vi.waitFor(() => {
      expect(queryRun).toHaveBeenCalledTimes(1);
    });
    expect(queryRun).toHaveBeenCalledWith('DELETE FROM users');
    expect(useSession.getState().prodGate).toBeNull();
  });
});
