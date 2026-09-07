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
const sqlFormat = vi.fn();

vi.mock('@/lib/ipc', () => ({
  ipc: {
    query: {
      run: (...args: unknown[]) => queryRun(...args),
      cancel: vi.fn(async () => undefined),
    },
    sql: {
      format: (...args: unknown[]) => sqlFormat(...args),
    },
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
  // Close down to one tab, then force a fresh SQL tab pair via setState.
  const freshA = {
    id: 'tab-a',
    title: 'a.sql',
    kind: 'sql' as const,
    sql: 'SELECT 1',
    queryRunState: 'idle' as const,
    queryResult: null,
    queryError: null,
    queryErrorSql: null,
    queryGeneration: 0,
    formatGeneration: 0,
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
  };
  const freshB = {
    ...freshA,
    id: 'tab-b',
    title: 'b.sql',
    sql: 'SELECT 2',
  };
  useSession.setState({
    tabs: [freshA, freshB],
    activeTabId: 'tab-a',
    prodGate: null,
    activeConfig: null,
    connectionState: 'idle',
  });
}

describe('U03 origin-tab SQL publish', () => {
  beforeEach(() => {
    queryRun.mockReset();
    sqlFormat.mockReset();
    resetStore();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('publishes a deferred result to the origin tab after switching away', async () => {
    const pending = deferred<typeof sampleResult>();
    queryRun.mockReturnValueOnce(pending.promise);

    const runPromise = useSession.getState().runQuery();
    expect(useSession.getState().tabs.find((t) => t.id === 'tab-a')?.queryRunState).toBe(
      'running',
    );

    useSession.getState().setActiveTab('tab-b');
    expect(useSession.getState().activeTabId).toBe('tab-b');

    pending.resolve(sampleResult);
    await runPromise;

    const state = useSession.getState();
    const tabA = state.tabs.find((t) => t.id === 'tab-a');
    const tabB = state.tabs.find((t) => t.id === 'tab-b');
    expect(tabA?.queryRunState).toBe('idle');
    expect(tabA?.queryResult).toEqual(sampleResult);
    expect(tabB?.queryResult).toBeNull();
    expect(tabB?.queryRunState).toBe('idle');
  });

  it('clears running and publishes errors on the origin tab after switching away', async () => {
    const pending = deferred<typeof sampleResult>();
    queryRun.mockReturnValueOnce(pending.promise);

    const runPromise = useSession.getState().runQuery();
    useSession.getState().setActiveTab('tab-b');

    pending.reject(new Error('boom'));
    await runPromise;

    const tabA = useSession.getState().tabs.find((t) => t.id === 'tab-a');
    const tabB = useSession.getState().tabs.find((t) => t.id === 'tab-b');
    expect(tabA?.queryRunState).toBe('idle');
    expect(tabA?.queryError).toBe('boom');
    expect(tabB?.queryError).toBeNull();
    expect(tabB?.queryResult).toBeNull();
  });

  it('drops a deferred result when the origin tab is closed', async () => {
    const pending = deferred<typeof sampleResult>();
    queryRun.mockReturnValueOnce(pending.promise);

    const runPromise = useSession.getState().runQuery();
    useSession.getState().closeTab('tab-a');
    expect(useSession.getState().tabs.some((t) => t.id === 'tab-a')).toBe(false);

    pending.resolve(sampleResult);
    await runPromise;

    const state = useSession.getState();
    expect(state.tabs.some((t) => t.id === 'tab-a')).toBe(false);
    // Surviving tab must not receive the orphaned result.
    for (const tab of state.tabs) {
      expect(tab.queryResult).toBeNull();
      expect(tab.queryRunState).toBe('idle');
    }
  });

  it('drops a superseded query result when generation advances', async () => {
    const pending = deferred<typeof sampleResult>();
    queryRun.mockReturnValueOnce(pending.promise);

    const runPromise = useSession.getState().runQuery();
    const genAfterStart = useSession.getState().tabs.find((t) => t.id === 'tab-a')!.queryGeneration;
    expect(genAfterStart).toBe(1);

    // Simulate a newer request claiming the tab (U01/U03 supersession).
    useSession.setState((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === 'tab-a' ? { ...t, queryGeneration: genAfterStart + 1, queryRunState: 'running' } : t,
      ),
    }));

    pending.resolve(sampleResult);
    await runPromise;

    const tabA = useSession.getState().tabs.find((t) => t.id === 'tab-a');
    expect(tabA?.queryResult).toBeNull();
    // Newer owner still marked running — stale publish must not clear it.
    expect(tabA?.queryRunState).toBe('running');
  });

  it('formats SQL back onto the origin tab after switching away', async () => {
    const pending = deferred<string>();
    sqlFormat.mockReturnValueOnce(pending.promise);

    const formatPromise = useSession.getState().formatActiveSql();
    useSession.getState().setActiveTab('tab-b');

    pending.resolve('SELECT\n  1');
    await formatPromise;

    const state = useSession.getState();
    expect(state.tabs.find((t) => t.id === 'tab-a')?.sql).toBe('SELECT\n  1');
    expect(state.tabs.find((t) => t.id === 'tab-b')?.sql).toBe('SELECT 2');
  });

  it('drops a deferred format when the origin tab is closed', async () => {
    const pending = deferred<string>();
    sqlFormat.mockReturnValueOnce(pending.promise);

    const formatPromise = useSession.getState().formatActiveSql();
    useSession.getState().closeTab('tab-a');

    pending.resolve('SELECT\n  1');
    await formatPromise;

    expect(useSession.getState().tabs.some((t) => t.id === 'tab-a')).toBe(false);
    expect(useSession.getState().tabs.find((t) => t.id === 'tab-b')?.sql).toBe('SELECT 2');
  });
});
