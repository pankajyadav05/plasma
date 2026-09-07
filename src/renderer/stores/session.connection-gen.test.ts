import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const queryRun = vi.fn();
const commitEditBatch = vi.fn();
const connConnect = vi.fn();
const connDisconnect = vi.fn();
const vaultConnectById = vi.fn();

vi.mock('@/lib/ipc', () => ({
  ipc: {
    query: {
      run: (...args: unknown[]) => queryRun(...args),
      commitEditBatch: (...args: unknown[]) => commitEditBatch(...args),
      cancel: vi.fn(async () => undefined),
    },
    sql: { format: vi.fn() },
    conn: {
      test: vi.fn(),
      connect: (...args: unknown[]) => connConnect(...args),
      disconnect: (...args: unknown[]) => connDisconnect(...args),
      introspect: vi.fn(async () => ({ schemas: [], tables: [], columns: [], foreignKeys: [] })),
    },
    vault: {
      list: vi.fn(async () => []),
      connectById: (...args: unknown[]) => vaultConnectById(...args),
      delete: vi.fn(),
      getConfig: vi.fn(),
    },
    schema: { introspect: vi.fn() },
    settings: { get: vi.fn(), set: vi.fn(async () => undefined) },
    history: { list: vi.fn(async () => []), clear: vi.fn() },
    txn: { begin: vi.fn(), commit: vi.fn(), rollback: vi.fn() },
    ai: { chat: vi.fn(), cancel: vi.fn() },
  },
}));

import { useSession } from './session';

function baseTab(id: string) {
  const pageSize = useSession.getState().settings.defaultPageSize;
  return {
    id,
    title: `${id}.sql`,
    kind: 'table' as const,
    sql: '',
    queryRunState: 'idle' as const,
    queryResult: {
      columns: [
        { name: 'id', dataTypeID: 23, dataTypeName: 'int4' },
        { name: 'email', dataTypeID: 25, dataTypeName: 'text' },
      ],
      rows: [[1, 'a@b.co']],
      rowCount: 1,
      durationMs: 1,
      command: 'SELECT',
    },
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
    tableSchema: 'public',
    tableName: 'users',
  };
}

function resetStore(connectionGen = 1) {
  useSession.setState({
    tabs: [baseTab('tab-a')],
    activeTabId: 'tab-a',
    prodGate: null,
    connectionActionGate: null,
    activeConfig: {
      id: 'conn-a',
      name: 'A',
      host: 'localhost',
      port: 5432,
      database: 'a',
      user: 'u',
      password: '',
      ssl: false,
      engine: 'postgres',
    },
    connectionState: 'connected',
    connectionGen,
    pendingEdits: [],
    pendingEditsBusy: false,
    editMode: true,
    txnState: 'none',
    schema: {
      schemas: [{ name: 'public' }],
      tables: [{ schema: 'public', name: 'users', kind: 'table', rowCountEstimate: 1 }],
      columns: [
        {
          schema: 'public',
          table: 'users',
          name: 'id',
          dataType: 'int4',
          ordinal: 1,
          isPrimaryKey: true,
          isNullable: false,
          hasDefault: false,
        },
        {
          schema: 'public',
          table: 'users',
          name: 'email',
          dataType: 'text',
          ordinal: 2,
          isPrimaryKey: false,
          isNullable: true,
          hasDefault: false,
        },
      ],
      foreignKeys: [],
    },
  });
}

beforeEach(() => {
  queryRun.mockReset();
  commitEditBatch.mockReset();
  connConnect.mockReset();
  connDisconnect.mockReset();
  vaultConnectById.mockReset();
  resetStore(1);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('U01 connection generation + pending edits', () => {
  it('stamps connectionGen on queued edits', async () => {
    await useSession.getState().updateCell(0, 1, 'new@b.co');
    const edits = useSession.getState().pendingEdits;
    expect(edits).toHaveLength(1);
    expect(edits[0].connectionGen).toBe(1);
    expect(edits[0].column).toBe('email');
  });

  it('preserves pending edits when the origin tab is closed', async () => {
    await useSession.getState().updateCell(0, 1, 'new@b.co');
    // Add a second tab so closeTab does not reset the only tab.
    useSession.setState((s) => ({
      tabs: [...s.tabs, { ...baseTab('tab-b'), kind: 'sql', tableSchema: undefined, tableName: undefined, queryResult: null }],
      activeTabId: 'tab-b',
    }));
    useSession.getState().closeTab('tab-a');
    expect(useSession.getState().tabs.find((t) => t.id === 'tab-a')).toBeUndefined();
    expect(useSession.getState().pendingEdits).toHaveLength(1);
    expect(useSession.getState().pendingEdits[0].tabId).toBe('tab-a');
    expect(useSession.getState().pendingEdits[0].connectionGen).toBe(1);
  });

  it('blocks disconnect while pending edits exist', async () => {
    await useSession.getState().updateCell(0, 1, 'new@b.co');
    await useSession.getState().disconnect();
    expect(connDisconnect).not.toHaveBeenCalled();
    expect(useSession.getState().connectionActionGate).toEqual({ kind: 'disconnect' });
    expect(useSession.getState().pendingEdits).toHaveLength(1);
  });

  it('blocks connectSaved while pending edits exist', async () => {
    await useSession.getState().updateCell(0, 1, 'new@b.co');
    await useSession.getState().connectSaved('conn-b');
    expect(vaultConnectById).not.toHaveBeenCalled();
    expect(useSession.getState().connectionActionGate).toEqual({
      kind: 'connectSaved',
      id: 'conn-b',
    });
  });

  it('discard then disconnect clears edits and proceeds', async () => {
    await useSession.getState().updateCell(0, 1, 'new@b.co');
    await useSession.getState().disconnect();
    connDisconnect.mockResolvedValue(undefined);
    queryRun.mockResolvedValue({
      columns: [
        { name: 'id', dataTypeID: 23, dataTypeName: 'int4' },
        { name: 'email', dataTypeID: 25, dataTypeName: 'text' },
      ],
      rows: [[1, 'a@b.co']],
      rowCount: 1,
      durationMs: 1,
    });
    await useSession.getState().resolveConnectionAction('discard');
    expect(useSession.getState().pendingEdits).toHaveLength(0);
    expect(connDisconnect).toHaveBeenCalledOnce();
    expect(useSession.getState().connectionActionGate).toBeNull();
    expect(useSession.getState().connectionGen).toBe(0);
  });

  it('refuses commit when edits belong to a previous generation', async () => {
    await useSession.getState().updateCell(0, 1, 'new@b.co');
    // Simulate a connection switch that somehow left stale edits (defense in depth).
    useSession.setState({ connectionGen: 2 });
    await expect(useSession.getState().commitPendingEdits()).rejects.toThrow(
      /previous connection/,
    );
    expect(commitEditBatch).not.toHaveBeenCalled();
  });

  it('commitPendingEdits sends one worker batch with connectionGen', async () => {
    await useSession.getState().updateCell(0, 1, 'new@b.co');
    commitEditBatch.mockResolvedValue({ state: 'none', applied: 1 });
    queryRun.mockResolvedValue({
      columns: [
        { name: 'id', dataTypeID: 23, dataTypeName: 'int4' },
        { name: 'email', dataTypeID: 25, dataTypeName: 'text' },
      ],
      rows: [[1, 'new@b.co']],
      rowCount: 1,
      durationMs: 1,
    });
    await useSession.getState().commitPendingEdits();
    expect(commitEditBatch).toHaveBeenCalledOnce();
    const arg = commitEditBatch.mock.calls[0][0];
    expect(arg.connectionGen).toBe(1);
    expect(arg.updates).toHaveLength(1);
    expect(arg.updates[0].sql).toMatch(/^UPDATE /);
    // Must NOT have issued BEGIN/COMMIT via query.run
    const sqlCalls = queryRun.mock.calls.map((c) => c[0]);
    expect(sqlCalls.some((s) => typeof s === 'string' && /^BEGIN/i.test(s))).toBe(false);
    expect(useSession.getState().pendingEdits).toHaveLength(0);
  });

  it('drops in-flight SQL results after connectionGen changes', async () => {
    // Switch active tab to a SQL tab and run a deferred query.
    const deferred = (() => {
      let resolve!: (v: unknown) => void;
      const promise = new Promise((res) => {
        resolve = res;
      });
      return { promise, resolve };
    })();
    queryRun.mockReturnValueOnce(deferred.promise);

    useSession.setState({
      tabs: [
        {
          ...baseTab('sql-a'),
          kind: 'sql',
          sql: 'SELECT 1',
          tableSchema: undefined,
          tableName: undefined,
          queryResult: null,
        },
      ],
      activeTabId: 'sql-a',
    });

    const runPromise = useSession.getState().runQuery();
    // Connection switches while query is in flight.
    useSession.setState({ connectionGen: 99 });
    deferred.resolve({
      columns: [{ name: 'n', dataTypeID: 23, dataTypeName: 'int4' }],
      rows: [[1]],
      rowCount: 1,
      durationMs: 1,
    });
    await runPromise;
    const tab = useSession.getState().tabs.find((t) => t.id === 'sql-a');
    expect(tab?.queryResult).toBeNull();
    expect(tab?.queryRunState).toBe('idle');
    expect(tab?.queryError).toMatch(/connection changed/);
  });
});
