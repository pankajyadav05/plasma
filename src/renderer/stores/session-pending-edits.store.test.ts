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

import { setBeforeCommitHook } from '@/lib/crash-recovery';
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
    expect(arg.updates[0].params).toEqual(['x@y.z', '1', 'a@b.co']);
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
    expect(commitEditBatch.mock.calls[0]?.[0].updates[0].params).toEqual(['x@y.z', '1', 'a@b.co']);
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

describe('bulk edits (set value / fill / paste / find & replace)', () => {
  function threeRows() {
    useSession.setState((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === 'tab-a' && t.queryResult
          ? {
              ...t,
              queryResult: {
                ...t.queryResult,
                rows: [
                  [1, 'a@b.co'],
                  [2, 'b@b.co'],
                  [3, null],
                ],
                rowCount: 3,
              },
            }
          : t,
      ),
    }));
  }

  it('stages many cells in one update and reports queued / unchanged / skipped', () => {
    threeRows();
    useSession.getState().deleteRows([1]);
    const res = useSession.getState().updateCells([
      { rowIndex: 0, columnIndex: 1, value: 'x' },
      { rowIndex: 1, columnIndex: 1, value: 'x' }, // row 1 is marked for deletion
      { rowIndex: 2, columnIndex: 1, value: null }, // already NULL
      { rowIndex: 9, columnIndex: 1, value: 'x' }, // not loaded
    ]);
    expect(res).toEqual({ queued: 1, unchanged: 1, skipped: 2 });
    const updates = tabAEdits().filter((e) => e.kind === 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ column: 'email', newValue: 'x', pkValues: { id: '1' } });
  });

  it('a later bulk value replaces the cell edit and typing the original back un-queues it', () => {
    threeRows();
    useSession.getState().updateCells([{ rowIndex: 0, columnIndex: 1, value: 'x' }]);
    useSession.getState().updateCells([{ rowIndex: 0, columnIndex: 1, value: 'y' }]);
    expect(tabAEdits().map((e) => e.newValue)).toEqual(['y']);
    useSession.getState().updateCells([{ rowIndex: 0, columnIndex: 1, value: 'a@b.co' }]);
    expect(tabAEdits()).toHaveLength(0);
  });

  it('refuses bulk edits on read-only connections, read-only safe mode and without edit mode', () => {
    threeRows();
    useSession.setState((s) => ({ activeConfig: { ...s.activeConfig!, readOnly: true } }));
    expect(() =>
      useSession.getState().updateCells([{ rowIndex: 0, columnIndex: 1, value: 'x' }]),
    ).toThrow(/read-only/);
    useSession.setState((s) => ({ activeConfig: { ...s.activeConfig!, readOnly: false } }));
    useSession.setState((s) => ({
      settings: { ...s.settings, safeModeDefault: 'read-only' as const },
    }));
    expect(() =>
      useSession.getState().updateCells([{ rowIndex: 0, columnIndex: 1, value: 'x' }]),
    ).toThrow(/safe mode/);
    useSession.setState((s) => ({
      settings: { ...s.settings, safeModeDefault: 'confirm-dangerous' as const },
    }));
    useSession.setState({ editMode: false });
    expect(() =>
      useSession.getState().updateCells([{ rowIndex: 0, columnIndex: 1, value: 'x' }]),
    ).toThrow(/edit mode/);
    expect(tabAEdits()).toHaveLength(0);
  });

  it('requires a primary key', () => {
    threeRows();
    useSession.setState((s) => ({
      schema: s.schema && {
        ...s.schema,
        columns: s.schema.columns.map((c) => ({ ...c, isPrimaryKey: false })),
      },
    }));
    expect(() =>
      useSession.getState().updateCells([{ rowIndex: 0, columnIndex: 1, value: 'x' }]),
    ).toThrow(/primary key/);
  });

  it('queues pasted rows as inserts in one update and edits them in bulk', () => {
    threeRows();
    expect(
      useSession.getState().insertRows([
        { id: '10', email: 'p' },
        { id: '11', email: 'q' },
      ]),
    ).toBe(2);
    const inserts = tabAEdits().filter((e) => e.kind === 'insert');
    expect(inserts.map((e) => e.values)).toEqual([
      { id: '10', email: 'p' },
      { id: '11', email: 'q' },
    ]);
    useSession.getState().updatePendingInserts([
      { id: inserts[0]!.id, column: 'email', value: 'P' },
      { id: inserts[1]!.id, column: 'email', value: null },
    ]);
    expect(tabAEdits().map((e) => e.values)).toEqual([
      { id: '10', email: 'P' },
      { id: '11', email: null },
    ]);
  });

  it('refuses pasted inserts on a read-only connection', () => {
    threeRows();
    useSession.setState((s) => ({ activeConfig: { ...s.activeConfig!, readOnly: true } }));
    expect(() => useSession.getState().insertRows([{ id: '10' }])).toThrow(/read-only/);
  });
});

describe('concurrent-edit conflicts (B1)', () => {
  beforeEach(() => {
    commitEditBatch.mockReset();
    queryRun.mockReset();
  });

  const stageAndCommit = async (lookup: unknown) => {
    await useSession.getState().updateCell(0, 1, 'mine');
    commitEditBatch.mockResolvedValue({
      state: 'none',
      applied: 0,
      conflicts: [{ index: 0, reason: 'no-match' }],
    });
    queryRun.mockResolvedValue(lookup);
    await useSession.getState().commitPendingEdits();
  };
  const theirsResult = {
    columns: [
      { name: 'id', dataTypeID: 23, dataTypeName: 'int4' },
      { name: 'email', dataTypeID: 25, dataTypeName: 'text' },
    ],
    rows: [[1, 'theirs@x.y']],
    rowCount: 1,
    durationMs: 1,
    command: 'SELECT',
  };
  const firstItem = () => useSession.getState().editConflicts?.items[0];

  it('keeps every staged edit, flags the row and opens the review', async () => {
    await stageAndCommit(theirsResult);
    const s = useSession.getState();
    expect(tabAEdits()).toHaveLength(1);
    expect(s.editConflicts?.items).toHaveLength(1);
    expect(firstItem()).toMatchObject({
      kind: 'changed',
      columns: [{ column: 'email', original: 'a@b.co', mine: 'mine', theirs: 'theirs@x.y' }],
    });
    expect(s.editConflictsOpen).toBe(true);
    expect(s.pendingEditsError?.editIds).toEqual(tabAEdits().map((e) => e.id));
    expect(s.pendingEditsError?.message).toMatch(/changed by someone else/);
    // the lookup is an internal, keyed read
    expect(queryRun.mock.calls[0]?.[0]).toMatch(
      /^SELECT \* FROM "public"."users" WHERE "id" = \$1/,
    );
    expect(queryRun.mock.calls[0]?.[2]).toEqual({ internal: true });
  });

  it('keep mine re-stages on the server values; the next commit compares against them', async () => {
    await stageAndCommit(theirsResult);
    useSession.getState().resolveEditConflict(firstItem()?.id ?? '', 'mine');
    const s = useSession.getState();
    expect(s.editConflicts).toBeNull();
    expect(s.editConflictsOpen).toBe(false);
    expect(s.pendingEditsError).toBeNull();
    expect(tabAEdits()[0]).toMatchObject({ oldValue: 'theirs@x.y', newValue: 'mine' });
    commitEditBatch.mockResolvedValue({ state: 'none', applied: 1 });
    await useSession.getState().commitPendingEdits();
    expect(commitEditBatch.mock.calls.at(-1)?.[0].updates[0].params).toEqual([
      'mine',
      '1',
      'theirs@x.y',
    ]);
    expect(tabAEdits()).toHaveLength(0);
  });

  it('take theirs drops my edit', async () => {
    await stageAndCommit(theirsResult);
    useSession.getState().resolveEditConflict(firstItem()?.id ?? '', 'theirs');
    expect(tabAEdits()).toHaveLength(0);
    expect(useSession.getState().editConflicts).toBeNull();
  });

  it('a row that was deleted offers only take theirs; keep mine changes nothing', async () => {
    await stageAndCommit({ ...theirsResult, rows: [], rowCount: 0 });
    const item = firstItem();
    expect(item?.kind).toBe('gone');
    useSession.getState().resolveEditConflict(item?.id ?? '', 'mine');
    expect(tabAEdits()).toHaveLength(1);
    expect(useSession.getState().editConflicts?.items).toHaveLength(1);
  });

  it('cancel closes the review but the edits and the flag stay', async () => {
    await stageAndCommit(theirsResult);
    useSession.getState().closeEditConflicts();
    expect(useSession.getState().editConflictsOpen).toBe(false);
    expect(tabAEdits()).toHaveLength(1);
    expect(useSession.getState().pendingEditsError).not.toBeNull();
    useSession.getState().openEditConflicts();
    expect(useSession.getState().editConflictsOpen).toBe(true);
  });

  it('discarding the tab’s edits clears the review', async () => {
    await stageAndCommit(theirsResult);
    await useSession.getState().revertPendingEdits();
    expect(useSession.getState().editConflicts).toBeNull();
  });

  it('a row that cannot be read back is still reported, as unknown', async () => {
    await useSession.getState().updateCell(0, 1, 'mine');
    commitEditBatch.mockResolvedValue({
      state: 'none',
      applied: 0,
      conflicts: [{ index: 0, reason: 'no-match' }],
    });
    queryRun.mockRejectedValue(new Error('permission denied'));
    await useSession.getState().commitPendingEdits();
    expect(firstItem()?.kind).toBe('unknown');
    expect(tabAEdits()).toHaveLength(1);
  });

  it('re-editing a staged cell after a reload keeps the ORIGINAL value as the guard (P0)', async () => {
    await useSession.getState().updateCell(0, 1, 'mine1');
    // The grid reloads: someone else changed the row meanwhile.
    useSession.setState((st) => ({
      tabs: st.tabs.map((t) =>
        t.id === 'tab-a' && t.queryResult
          ? { ...t, queryResult: { ...t.queryResult, rows: [[1, 'theirs']] } }
          : t,
      ),
    }));
    await useSession.getState().updateCell(0, 1, 'mine2');
    expect(tabAEdits()[0]).toMatchObject({ oldValue: 'a@b.co', newValue: 'mine2' });
    commitEditBatch.mockResolvedValue({ state: 'none', applied: 1 });
    await useSession.getState().commitPendingEdits();
    expect(commitEditBatch.mock.calls.at(-1)?.[0].updates[0].params).toEqual([
      'mine2',
      '1',
      'a@b.co',
    ]);
  });

  it('typing the original back after a reload still un-stages the edit', async () => {
    await useSession.getState().updateCell(0, 1, 'mine1');
    useSession.setState((st) => ({
      tabs: st.tabs.map((t) =>
        t.id === 'tab-a' && t.queryResult
          ? { ...t, queryResult: { ...t.queryResult, rows: [[1, 'theirs']] } }
          : t,
      ),
    }));
    await useSession.getState().updateCell(0, 1, 'a@b.co');
    expect(tabAEdits()).toHaveLength(0);
  });
});

describe('a commit that a crash interrupts (B2 / P2-3)', () => {
  beforeEach(() => {
    commitEditBatch.mockReset();
    queryRun.mockReset();
    setBeforeCommitHook(null);
  });
  afterEach(() => setBeforeCommitHook(null));

  const markMaybeCommitted = () =>
    useSession.setState((s) => ({
      pendingEditsByTab: {
        ...s.pendingEditsByTab,
        'tab-a': (s.pendingEditsByTab['tab-a'] ?? []).map((e) => ({ ...e, maybeCommitted: true })),
      },
    }));

  it('the snapshot is told which edits are in flight BEFORE the request leaves, and cleared after', async () => {
    await useSession.getState().updateCell(0, 1, 'mine');
    const ids = tabAEdits().map((e) => e.id);
    const order: string[] = [];
    setBeforeCommitHook(async () => {
      order.push(`hook:${useSession.getState().commitInFlightIds.join(',')}`);
    });
    commitEditBatch.mockImplementation(async () => {
      order.push('sent');
      return { state: 'none', applied: 1 };
    });
    await useSession.getState().commitPendingEdits();
    expect(order).toEqual([`hook:${ids.join(',')}`, 'sent']);
    expect(useSession.getState().commitInFlightIds).toEqual([]);
  });

  it('a failing hook never blocks the commit', async () => {
    await useSession.getState().updateCell(0, 1, 'mine');
    setBeforeCommitHook(async () => {
      throw new Error('disk full');
    });
    commitEditBatch.mockResolvedValue({ state: 'none', applied: 1 });
    await useSession.getState().commitPendingEdits();
    expect(commitEditBatch).toHaveBeenCalledOnce();
  });

  it('a restored INSERT whose key already exists is not sent again', async () => {
    await useSession.getState().insertRow({ id: '2', email: 'n@e.w' });
    markMaybeCommitted();
    queryRun.mockResolvedValue({
      columns: [{ name: 'id', dataTypeID: 23, dataTypeName: 'int4' }],
      rows: [[2]],
      rowCount: 1,
      durationMs: 1,
      command: 'SELECT',
    });
    await useSession.getState().commitPendingEdits();
    expect(commitEditBatch).not.toHaveBeenCalled();
    expect(useSession.getState().editConflicts?.items[0]).toMatchObject({
      op: 'insert',
      kind: 'duplicate',
    });
    expect(tabAEdits()).toHaveLength(1);
  });

  it('a restored INSERT whose key is not in the table yet is committed', async () => {
    await useSession.getState().insertRow({ id: '2', email: 'n@e.w' });
    markMaybeCommitted();
    queryRun.mockResolvedValue({
      columns: [],
      rows: [],
      rowCount: 0,
      durationMs: 1,
      command: 'SELECT',
    });
    commitEditBatch.mockResolvedValue({ state: 'none', applied: 1 });
    await useSession.getState().commitPendingEdits();
    expect(commitEditBatch).toHaveBeenCalledOnce();
    expect(tabAEdits()).toHaveLength(0);
  });

  it('a restored INSERT with a server-generated key cannot be checked, so it is held back', async () => {
    await useSession.getState().insertRow({ email: 'n@e.w' });
    markMaybeCommitted();
    await useSession.getState().commitPendingEdits();
    expect(commitEditBatch).not.toHaveBeenCalled();
    expect(queryRun).not.toHaveBeenCalled();
    expect(useSession.getState().editConflicts?.items[0]?.kind).toBe('maybe-saved');
    expect(useSession.getState().pendingEditsError?.message).toMatch(/may already be saved/);
    expect(tabAEdits()).toHaveLength(1);
  });

  it('a restored UPDATE needs no check: its guarded WHERE refuses to apply twice', async () => {
    await useSession.getState().updateCell(0, 1, 'mine');
    markMaybeCommitted();
    commitEditBatch.mockResolvedValue({ state: 'none', applied: 1 });
    await useSession.getState().commitPendingEdits();
    expect(queryRun.mock.calls.some((c) => /LIMIT 2/.test(String(c[0])))).toBe(false);
    expect(commitEditBatch).toHaveBeenCalledOnce();
  });
});
