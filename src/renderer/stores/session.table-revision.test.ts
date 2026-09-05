import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

const page1Result = {
  columns: [{ name: 'id', dataTypeId: 23 }],
  rows: [[1]],
  rowCount: 1,
  command: 'SELECT',
  durationMs: 1,
};

const page2Result = {
  columns: [{ name: 'id', dataTypeId: 23 }],
  rows: [[2]],
  rowCount: 1,
  command: 'SELECT',
  durationMs: 1,
};

const countResult = (n: number) => ({
  columns: [{ name: 'count', dataTypeId: 20 }],
  rows: [[String(n)]],
  rowCount: 1,
  command: 'SELECT',
  durationMs: 1,
});

function resetTableTab() {
  const pageSize = useSession.getState().settings.defaultPageSize;
  useSession.setState({
    tabs: [
      {
        id: 'table-a',
        title: 'users',
        kind: 'table',
        sql: '',
        queryRunState: 'idle',
        queryResult: null,
        queryError: null,
        queryErrorSql: null,
        tableDataGeneration: 0,
        tableCountGeneration: 0,
        page: 0,
        pageSize,
        sortColumn: null,
        selectedCell: null,
        selectedRows: new Set<number>(),
        columnWidths: {},
        tableSchema: 'public',
        tableName: 'users',
        tableSort: [],
        filters: [],
        hiddenColumns: new Set<string>(),
        stickyColumns: new Set<string>(),
        totalRowCount: null,
        totalRowCountIsEstimate: false,
        countLoading: false,
        viewMode: 'data',
        rlsPolicyCount: null,
      },
    ],
    activeTabId: 'table-a',
    activeTable: { schema: 'public', name: 'users' },
    schema: {
      schemas: [{ name: 'public' }],
      tables: [{ schema: 'public', name: 'users', kind: 'table', rowCountEstimate: 10 }],
      columns: [
        {
          schema: 'public',
          table: 'users',
          name: 'id',
          dataType: 'integer',
          isNullable: false,
          ordinal: 1,
          isPrimaryKey: true,
          hasDefault: false,
        },
      ],
      foreignKeys: [],
    },
    prodGate: null,
    activeConfig: { id: 'c1', name: 'local', engine: 'postgres' } as never,
    connectionState: 'connected',
  });
}

describe('U23 table-tab request revision', () => {
  beforeEach(() => {
    queryRun.mockReset();
    resetTableTab();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('applies the latest data response and drops a superseded older one', async () => {
    const first = deferred<typeof page1Result>();
    const second = deferred<typeof page2Result>();
    queryRun.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    useSession.getState().setPage(1);
    expect(useSession.getState().tabs[0]?.tableDataGeneration).toBe(1);
    expect(useSession.getState().tabs[0]?.queryRunState).toBe('running');

    useSession.getState().setPage(2);
    expect(useSession.getState().tabs[0]?.tableDataGeneration).toBe(2);
    expect(useSession.getState().tabs[0]?.page).toBe(2);

    // Stale first response must not win.
    first.resolve(page1Result);
    await Promise.resolve();
    await Promise.resolve();

    let tab = useSession.getState().tabs[0];
    expect(tab?.queryResult).toBeNull();
    expect(tab?.queryRunState).toBe('running');
    expect(tab?.tableDataGeneration).toBe(2);

    second.resolve(page2Result);
    await Promise.resolve();
    await Promise.resolve();

    tab = useSession.getState().tabs[0];
    expect(tab?.queryResult).toEqual(page2Result);
    expect(tab?.queryRunState).toBe('idle');
    expect(tab?.tableDataGeneration).toBe(2);
  });

  it('drops a stale data error when a newer request is in flight', async () => {
    const first = deferred<typeof page1Result>();
    const second = deferred<typeof page2Result>();
    queryRun.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    useSession.getState().setPage(1);
    useSession.getState().setPage(2);

    first.reject(new Error('stale boom'));
    await Promise.resolve();
    await Promise.resolve();

    let tab = useSession.getState().tabs[0];
    expect(tab?.queryError).toBeNull();
    expect(tab?.queryRunState).toBe('running');

    second.resolve(page2Result);
    await Promise.resolve();
    await Promise.resolve();

    tab = useSession.getState().tabs[0];
    expect(tab?.queryResult).toEqual(page2Result);
    expect(tab?.queryError).toBeNull();
    expect(tab?.queryRunState).toBe('idle');
  });

  it('applies the latest count and drops a superseded older count', async () => {
    // addFilter awaits data then fires count. Hold both pairs so we can
    // interleave count completions after a second filter change.
    const data1 = deferred<typeof page1Result>();
    const count1 = deferred<ReturnType<typeof countResult>>();
    const data2 = deferred<typeof page2Result>();
    const count2 = deferred<ReturnType<typeof countResult>>();
    queryRun
      .mockReturnValueOnce(data1.promise)
      .mockReturnValueOnce(count1.promise)
      .mockReturnValueOnce(data2.promise)
      .mockReturnValueOnce(count2.promise);

    const filterA = { id: 'f1', column: 'id', op: '=' as const, value: '1' };
    const filterB = { id: 'f2', column: 'id', op: '=' as const, value: '2' };

    const p1 = useSession.getState().addFilter(filterA);
    // Resolve first data so addFilter proceeds to count.
    data1.resolve(page1Result);
    await p1;
    expect(useSession.getState().tabs[0]?.tableCountGeneration).toBe(1);
    expect(useSession.getState().tabs[0]?.countLoading).toBe(true);

    const p2 = useSession.getState().addFilter(filterB);
    data2.resolve(page2Result);
    await p2;
    expect(useSession.getState().tabs[0]?.tableCountGeneration).toBe(2);

    // Stale count from first filter set must not overwrite.
    count1.resolve(countResult(111));
    await Promise.resolve();
    await Promise.resolve();

    let tab = useSession.getState().tabs[0];
    expect(tab?.totalRowCount).toBeNull();
    expect(tab?.countLoading).toBe(true);
    expect(tab?.tableCountGeneration).toBe(2);

    count2.resolve(countResult(222));
    await Promise.resolve();
    await Promise.resolve();

    tab = useSession.getState().tabs[0];
    expect(tab?.totalRowCount).toBe(222);
    expect(tab?.countLoading).toBe(false);
  });

  it('does not recreate a closed table tab from a late data response', async () => {
    // Keep a second tab so closeTab removes table-a instead of resetting it.
    const pageSize = useSession.getState().settings.defaultPageSize;
    useSession.setState((s) => ({
      tabs: [
        ...s.tabs,
        {
          id: 'sql-b',
          title: 'b.sql',
          kind: 'sql' as const,
          sql: '',
          queryRunState: 'idle' as const,
          queryResult: null,
          queryError: null,
          queryErrorSql: null,
          tableDataGeneration: 0,
          tableCountGeneration: 0,
          page: 0,
          pageSize,
          sortColumn: null,
          selectedCell: null,
          selectedRows: new Set<number>(),
          columnWidths: {},
          tableSort: [],
          filters: [],
          hiddenColumns: new Set<string>(),
          stickyColumns: new Set<string>(),
          totalRowCount: null,
          totalRowCountIsEstimate: false,
          countLoading: false,
          viewMode: 'data' as const,
          rlsPolicyCount: null,
        },
      ],
    }));

    const pending = deferred<typeof page1Result>();
    queryRun.mockReturnValueOnce(pending.promise);

    useSession.getState().setPage(1);
    useSession.getState().closeTab('table-a');
    expect(useSession.getState().tabs.some((t) => t.id === 'table-a')).toBe(false);

    pending.resolve(page1Result);
    await Promise.resolve();
    await Promise.resolve();

    expect(useSession.getState().tabs.some((t) => t.id === 'table-a')).toBe(false);
    for (const tab of useSession.getState().tabs) {
      expect(tab.queryResult).toBeNull();
    }
  });
});
