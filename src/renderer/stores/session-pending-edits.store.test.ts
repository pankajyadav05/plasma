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
import { editsOf, pendingEditCount } from './session-pending-edits';

const tabAEdits = () => editsOf(useSession.getState().pendingEditsByTab, 'tab-a');

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
    pendingEditsByTab: {},
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
    settings: { ...s.settings, connectionTags: {}, safeModeDefault: 'confirm-dangerous' as const },
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
    expect(tabAEdits()).toHaveLength(0);
    await useSession.getState().updateCell(0, 1, 'x@y.z');
    expect(tabAEdits()).toHaveLength(1);
    await useSession.getState().updateCell(0, 1, 'a@b.co');
    expect(tabAEdits()).toHaveLength(0);
  });

  it('keeps NULL distinct from empty string and never mutates server rows', async () => {
    await useSession.getState().updateCell(0, 1, null);
    const [edit] = tabAEdits();
    expect(edit?.newValue).toBeNull();
    expect(edit?.pkValues).toEqual({ id: '1' });
    expect(useSession.getState().tabs[0]?.queryResult?.rows[0]).toEqual([1, 'a@b.co']);
  });

  it('queues deletes and inserts instead of running them', async () => {
    await useSession.getState().deleteRow(0);
    await useSession.getState().insertRow({ id: '2', email: '' });
    expect(queryRun).not.toHaveBeenCalled();
    const kinds = tabAEdits().map((e) => e.kind);
    expect(kinds).toEqual(['delete', 'insert']);
    // email is nullable → '' becomes NULL
    expect(tabAEdits()[1]?.values).toEqual({ id: '2', email: null });
    // Deleting again restores the row.
    useSession.getState().deleteRows([0]);
    expect(tabAEdits().map((e) => e.kind)).toEqual(['insert']);
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
    expect(tabAEdits()).toHaveLength(0);
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
    const id = tabAEdits()[0]?.id;
    commitEditBatch.mockRejectedValue(
      new Error(
        'Error invoking remote method \'plasma:query:commitEditBatch\': Error: Edit 1 of 1 (update "public"."users") failed: value too long. Nothing was saved.',
      ),
    );
    await expect(useSession.getState().commitPendingEdits()).rejects.toThrow(/value too long/);
    expect(tabAEdits()).toHaveLength(1);
    const err = useSession.getState().pendingEditsError;
    expect(err?.editIds).toEqual([id]);
    expect(err?.message).not.toMatch(/Error invoking remote method/);
  });

  it('refuses writes on a read-only connection', async () => {
    useSession.setState((s) => ({ activeConfig: { ...s.activeConfig!, readOnly: true } }));
    await expect(useSession.getState().updateCell(0, 1, 'x')).rejects.toThrow(/read-only/);
  });
});

describe('per-tab pending edits (R-01 / R-02 / R-03 / R-04)', () => {
  const stageInTabA = async () => {
    await useSession.getState().updateCell(0, 1, 'x@y.z');
  };

  const addSqlTab = (id = 'tab-sql') => {
    useSession.setState((s) => ({
      tabs: [...s.tabs, { ...baseTab(id), kind: 'sql' as const, sql: '', queryResult: null }],
    }));
  };

  it('keys staged edits by tab id and never leaks them to another tab', async () => {
    await stageInTabA();
    addSqlTab();
    useSession.getState().setActiveTab('tab-sql');
    const byTab = useSession.getState().pendingEditsByTab;
    expect(Object.keys(byTab)).toEqual(['tab-a']);
    expect(editsOf(byTab, 'tab-sql')).toHaveLength(0);
  });

  it('commit from another tab commits nothing (R-01)', async () => {
    await stageInTabA();
    addSqlTab();
    useSession.getState().setActiveTab('tab-sql');
    await useSession.getState().commitPendingEdits();
    expect(commitEditBatch).not.toHaveBeenCalled();
    expect(tabAEdits()).toHaveLength(1);
  });

  it('commits only the requested tab and leaves other tabs staged', async () => {
    await stageInTabA();
    useSession.setState((s) => ({
      tabs: [...s.tabs, { ...baseTab('tab-b'), tableName: 'users' }],
    }));
    useSession.getState().setActiveTab('tab-b');
    await useSession.getState().updateCell(0, 1, 'other@x.y');
    expect(pendingEditCount(useSession.getState().pendingEditsByTab)).toBe(2);
    commitEditBatch.mockResolvedValue({ state: 'none', applied: 1 });
    await useSession.getState().commitPendingEdits({ tabId: 'tab-a' });
    expect(commitEditBatch).toHaveBeenCalledOnce();
    expect(commitEditBatch.mock.calls[0]?.[0].updates[0].params).toEqual(['x@y.z', '1']);
    expect(tabAEdits()).toHaveLength(0);
    expect(editsOf(useSession.getState().pendingEditsByTab, 'tab-b')).toHaveLength(1);
  });

  it('closing a tab drops its staged edits; the confirm names the count (R-02)', async () => {
    await stageInTabA();
    useSession.getState().requestCloseTabs(['tab-a']);
    const req = useSession.getState().closeTabsRequest;
    expect(req?.ids).toEqual(['tab-a']);
    expect(req?.editCount).toBe(1);
    expect(req?.dirtyTitles).toEqual(['tab-a.sql']);
    useSession.getState().confirmCloseTabs();
    expect(useSession.getState().pendingEditsByTab).toEqual({});
  });

  it('closing a tab without edits does not ask', () => {
    addSqlTab();
    useSession.getState().requestCloseTabs(['tab-sql']);
    expect(useSession.getState().closeTabsRequest).toBeNull();
  });

  it('a refusal by read-only safe mode is stored as an object, not a string (R-03)', async () => {
    await stageInTabA();
    useSession.setState((s) => ({
      settings: { ...s.settings, safeModeDefault: 'read-only' },
    }));
    await useSession.getState().commitPendingEdits();
    const err = useSession.getState().pendingEditsError;
    expect(typeof err).toBe('object');
    expect(err?.message).toMatch(/read-only/i);
    expect(err?.editIds).toEqual([]);
    expect(commitEditBatch).not.toHaveBeenCalled();
  });

  it('refuses to stage edits while safe mode is read-only (R-03)', async () => {
    useSession.setState((s) => ({
      settings: { ...s.settings, safeModeDefault: 'read-only' },
    }));
    await expect(useSession.getState().updateCell(0, 1, 'x')).rejects.toThrow(/safe mode/i);
  });

  it('records why a commit was refused after the connection changed (R-04)', async () => {
    await stageInTabA();
    useSession.setState({ connectionGen: 2 });
    await expect(useSession.getState().commitPendingEdits()).rejects.toThrow(/previous connection/);
    expect(useSession.getState().pendingEditsError?.message).toMatch(/previous connection/);
  });

  it('re-targets staged edits when the same connection is recovered (R-04)', async () => {
    await stageInTabA();
    useSession.getState().handleConnectionRecovered({
      connectionId: 'conn-a',
      serverVersion: 'PostgreSQL 16',
      connectionGen: 5,
    } as never);
    expect(tabAEdits()[0]?.connectionGen).toBe(5);
    commitEditBatch.mockResolvedValue({ state: 'none', applied: 1 });
    await useSession.getState().commitPendingEdits();
    expect(commitEditBatch).toHaveBeenCalledOnce();
  });

  it('the connection gate commits every tab, and stays open with the message on failure (R-04)', async () => {
    await stageInTabA();
    useSession.setState({ connectionActionGate: { kind: 'disconnect' } });
    commitEditBatch.mockRejectedValue(new Error('boom'));
    await useSession.getState().resolveConnectionAction('commit');
    expect(useSession.getState().connectionActionGate).not.toBeNull();
    expect(useSession.getState().pendingEditsError?.message).toBe('boom');
    expect(tabAEdits()).toHaveLength(1);
    await useSession.getState().resolveConnectionAction('discard');
    expect(useSession.getState().pendingEditsByTab).toEqual({});
  });
});
