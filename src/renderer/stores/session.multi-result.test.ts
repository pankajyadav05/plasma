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
      introspect: vi.fn(),
    },
    settings: { get: vi.fn(), set: vi.fn(async () => undefined) },
    history: { list: vi.fn(async () => []), clear: vi.fn() },
    txn: { begin: vi.fn(), commit: vi.fn(), rollback: vi.fn() },
    ai: { chat: vi.fn(), cancel: vi.fn() },
  },
}));

import { useSession } from './session';

function makeResult(overrides: Partial<{
  command: string;
  rowCount: number;
  cols: number;
  durationMs: number;
  notices: Array<{ message: string; severity?: string }>;
}> = {}) {
  const cols = overrides.cols ?? 1;
  return {
    columns:
      cols > 0
        ? Array.from({ length: cols }, (_, i) => ({
            name: `c${i}`,
            dataTypeID: 23,
            dataTypeName: 'int4',
          }))
        : [],
    rows: cols > 0 ? [[1]] : [],
    rowCount: overrides.rowCount ?? (cols > 0 ? 1 : 0),
    command: overrides.command ?? (cols > 0 ? 'SELECT' : 'INSERT'),
    durationMs: overrides.durationMs ?? 3,
    notices: overrides.notices,
  };
}

function seedSqlTab(sql: string) {
  const pageSize = useSession.getState().settings.defaultPageSize;
  useSession.setState({
    tabs: [
      {
        id: 'tab-a',
        title: 'a.sql',
        kind: 'sql' as const,
        sql,
        queryRunState: 'idle' as const,
        queryResult: null,
        queryError: null,
        queryErrorSql: null,
        queryResults: [],
        activeResultIndex: 0,
        queryGeneration: 0,
        queryNotices: [],
        queryRunningRange: null,
        queryErrorRange: null,
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
    activeTabId: 'tab-a',
    connectionState: 'connected',
    activeConfig: {
      id: 'c1',
      name: 'local',
      engine: 'postgres' as const,
      host: 'localhost',
      port: 5432,
      database: 'db',
      user: 'u',
      password: '',
      ssl: false,
    },
    settings: {
      ...useSession.getState().settings,
      connectionTags: {},
    },
    prodGate: null,
  });
}

describe('U26 multi-result runQuery', () => {
  beforeEach(() => {
    queryRun.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('collects QueryResult[] and selects the last SELECT by default', async () => {
    seedSqlTab('INSERT INTO t VALUES (1); SELECT 1; SELECT 2;');
    queryRun
      .mockResolvedValueOnce(makeResult({ command: 'INSERT', cols: 0, rowCount: 1, durationMs: 1 }))
      .mockResolvedValueOnce(makeResult({ command: 'SELECT', cols: 1, durationMs: 2 }))
      .mockResolvedValueOnce(makeResult({ command: 'SELECT', cols: 1, durationMs: 4 }));

    await useSession.getState().runQuery({ all: true });

    const tab = useSession.getState().tabs[0]!;
    expect(queryRun).toHaveBeenCalledTimes(3);
    expect(tab.queryResults).toHaveLength(3);
    expect(tab.queryResults.map((r) => r.command)).toEqual(['INSERT', 'SELECT', 'SELECT']);
    // Last SELECT is index 2
    expect(tab.activeResultIndex).toBe(2);
    expect(tab.queryResult?.durationMs).toBe(4);
    expect(tab.queryRunState).toBe('idle');
  });

  it('keeps partial results when a later statement fails', async () => {
    seedSqlTab('SELECT 1; SELECT bad;');
    queryRun
      .mockResolvedValueOnce(makeResult({ command: 'SELECT', durationMs: 2 }))
      .mockRejectedValueOnce(new Error('column "bad" does not exist'));

    await useSession.getState().runQuery({ all: true });

    const tab = useSession.getState().tabs[0]!;
    expect(tab.queryResults).toHaveLength(1);
    expect(tab.queryResult?.command).toBe('SELECT');
    expect(tab.queryError).toMatch(/column "bad"/);
    expect(tab.queryError).toMatch(/statement 2 of 2/);
    expect(tab.queryRunState).toBe('idle');
  });

  it('setActiveResultIndex / cycleActiveResult switch the visible grid', async () => {
    seedSqlTab('SELECT 1; SELECT 2;');
    queryRun
      .mockResolvedValueOnce(makeResult({ command: 'SELECT', durationMs: 1 }))
      .mockResolvedValueOnce(makeResult({ command: 'SELECT', durationMs: 9 }));

    await useSession.getState().runQuery({ all: true });
    let tab = useSession.getState().tabs[0]!;
    expect(tab.activeResultIndex).toBe(1);

    useSession.getState().setActiveResultIndex(0);
    tab = useSession.getState().tabs[0]!;
    expect(tab.activeResultIndex).toBe(0);
    expect(tab.queryResult?.durationMs).toBe(1);

    useSession.getState().cycleActiveResult(1);
    tab = useSession.getState().tabs[0]!;
    expect(tab.activeResultIndex).toBe(1);
    expect(tab.queryResult?.durationMs).toBe(9);
  });

  it('merges streamed notices onto the matching statement result', async () => {
    seedSqlTab('SELECT 1;');
    const d = deferred<ReturnType<typeof makeResult>>();
    queryRun.mockReturnValueOnce(d.promise);

    const runPromise = useSession.getState().runQuery({ all: true });
    // While running, stream a NOTICE for statement 0
    useSession.getState().appendPgNotice({
      message: 'hello from raise',
      severity: 'NOTICE',
    });
    d.resolve(makeResult({ command: 'SELECT', notices: [{ message: 'from driver' }] }));
    await runPromise;

    const tab = useSession.getState().tabs[0]!;
    expect(tab.queryNotices).toHaveLength(1);
    expect(tab.queryResult?.notices?.map((n) => n.message).sort()).toEqual([
      'from driver',
      'hello from raise',
    ]);
  });

  it('publishes results to the origin tab even if another tab becomes active', async () => {
    seedSqlTab('SELECT 1;');
    // Add a second tab and switch to it mid-flight
    useSession.setState((s) => ({
      tabs: [
        ...s.tabs,
        {
          ...s.tabs[0]!,
          id: 'tab-b',
          title: 'b.sql',
          sql: 'SELECT 99',
          queryGeneration: 0,
          queryResults: [],
          queryNotices: [],
          activeResultIndex: 0,
        },
      ],
    }));

    const d = deferred<ReturnType<typeof makeResult>>();
    queryRun.mockReturnValueOnce(d.promise);
    const runPromise = useSession.getState().runQuery({ all: true });

    // Flip active tab while query is in flight
    useSession.getState().setActiveTab('tab-b');
    d.resolve(makeResult({ command: 'SELECT', durationMs: 5 }));
    await runPromise;

    const a = useSession.getState().tabs.find((t) => t.id === 'tab-a')!;
    const b = useSession.getState().tabs.find((t) => t.id === 'tab-b')!;
    expect(a.queryResults).toHaveLength(1);
    expect(a.queryResult?.durationMs).toBe(5);
    expect(b.queryResult).toBeNull();
    expect(useSession.getState().activeTabId).toBe('tab-b');
  });
});
