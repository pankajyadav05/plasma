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
      routines: [],
      sequences: [],
      types: [],
      extensions: [],
    },
  });
}

beforeEach(() => {
  queryRun.mockReset();
  commitEditBatch.mockReset();
  resetStore(1);
  useSession.setState((s) => ({
    settings: { ...s.settings, connectionTags: {} },
    pendingEditsError: null,
  }));
  queryRun.mockResolvedValue({
    columns: [
      { name: 'id', dataTypeID: 23, dataTypeName: 'int4' },
      { name: 'email', dataTypeID: 25, dataTypeName: 'text' },
    ],
    rows: [[1, 'a@b.co']],
    rowCount: 1,
    durationMs: 1,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('grid pending edits (A1 / A5 / B3)', () => {
  it('does not queue a no-op edit and un-queues when the original is typed back', async () => {
    await useSession.getState().updateCell(0, 1, 'a@b.co');
    expect(useSession.getState().pendingEdits).toHaveLength(0);
    await useSession.getState().updateCell(0, 1, 'x@y.z');
    expect(useSession.getState().pendingEdits).toHaveLength(1);
    await useSession.getState().updateCell(0, 1, 'a@b.co');
    expect(useSession.getState().pendingEdits).toHaveLength(0);
  });

  it('keeps NULL distinct from empty string and never mutates server rows', async () => {
    await useSession.getState().updateCell(0, 1, null);
    const [edit] = useSession.getState().pendingEdits;
    expect(edit?.newValue).toBeNull();
    expect(edit?.pkValues).toEqual({ id: '1' });
    expect(useSession.getState().tabs[0]?.queryResult?.rows[0]).toEqual([1, 'a@b.co']);
  });

  it('queues deletes and inserts instead of running them', async () => {
    await useSession.getState().deleteRow(0);
    await useSession.getState().insertRow({ id: '2', email: '' });
    expect(queryRun).not.toHaveBeenCalled();
    const kinds = useSession.getState().pendingEdits.map((e) => e.kind);
    expect(kinds).toEqual(['delete', 'insert']);
    // email is nullable → '' becomes NULL
    expect(useSession.getState().pendingEdits[1]?.values).toEqual({ id: '2', email: null });
    // Deleting again restores the row.
    useSession.getState().deleteRows([0]);
    expect(useSession.getState().pendingEdits.map((e) => e.kind)).toEqual(['insert']);
  });

  it('commits deletes + updates + inserts in one ordered batch', async () => {
    await useSession.getState().updateCell(0, 1, 'x@y.z');
    await useSession.getState().insertRow({ id: '2', email: 'n@e.w' });
    commitEditBatch.mockResolvedValue({ state: 'none', applied: 2 });
    await useSession.getState().commitPendingEdits();
    const arg = commitEditBatch.mock.calls[0]?.[0];
    expect(arg.updates.map((u: { sql: string }) => u.sql.split(' ')[0])).toEqual([
      'UPDATE',
      'INSERT',
    ]);
    expect(arg.updates[0].params).toEqual(['x@y.z', '1']);
    expect(useSession.getState().pendingEdits).toHaveLength(0);
  });

  it('prod-tagged connections confirm before committing', async () => {
    useSession.setState((s) => ({
      settings: { ...s.settings, connectionTags: { 'conn-a': 'prod' } },
    }));
    await useSession.getState().updateCell(0, 1, 'x@y.z');
    await useSession.getState().commitPendingEdits();
    expect(commitEditBatch).not.toHaveBeenCalled();
    expect(useSession.getState().prodGate?.kind).toBe('commitEdits');
    commitEditBatch.mockResolvedValue({ state: 'none', applied: 1 });
    useSession.getState().confirmProdGate();
    await vi.waitFor(() => expect(commitEditBatch).toHaveBeenCalledOnce());
  });

  it('keeps the tray and points at the failing edit when the commit fails', async () => {
    await useSession.getState().updateCell(0, 1, 'x@y.z');
    const id = useSession.getState().pendingEdits[0]?.id;
    commitEditBatch.mockRejectedValue(
      new Error(
        'Error invoking remote method \'plasma:query:commitEditBatch\': Error: Edit 1 of 1 (update "public"."users") failed: value too long. Nothing was saved.',
      ),
    );
    await expect(useSession.getState().commitPendingEdits()).rejects.toThrow(/value too long/);
    expect(useSession.getState().pendingEdits).toHaveLength(1);
    const err = useSession.getState().pendingEditsError;
    expect(err?.editIds).toEqual([id]);
    expect(err?.message).not.toMatch(/Error invoking remote method/);
  });

  it('refuses writes on a read-only connection', async () => {
    useSession.setState((s) => ({ activeConfig: { ...s.activeConfig!, readOnly: true } }));
    await expect(useSession.getState().updateCell(0, 1, 'x')).rejects.toThrow(/read-only/);
  });
});
