import { beforeEach, describe, expect, it, vi } from 'vitest';

const compareRun = vi.fn();
const exportSave = vi.fn();
const settingsSet = vi.fn(async (_patch?: unknown) => ({}) as unknown);

vi.mock('@/lib/ipc', () => ({
  ipc: {
    compare: { run: (...a: unknown[]) => compareRun(...a) },
    export: { save: (...a: unknown[]) => exportSave(...a) },
    query: { run: vi.fn(), cancel: vi.fn(async () => 'sent') },
    sql: { format: vi.fn() },
    conn: { test: vi.fn(), connect: vi.fn(), disconnect: vi.fn() },
    schema: { introspect: vi.fn() },
    settings: { get: vi.fn(), set: (...a: unknown[]) => settingsSet(...a) },
    history: { list: vi.fn(async () => []), clear: vi.fn() },
    txn: { begin: vi.fn(), commit: vi.fn(), rollback: vi.fn() },
    ai: { ask: vi.fn(), cancel: vi.fn() },
  },
}));

import { useCompare } from './compare';
import { useSession } from './session';

const res = (rows: unknown[][], over: Record<string, unknown> = {}) => ({
  columns: [
    { name: 'id', dataTypeID: 23, dataTypeName: 'int4' },
    { name: 'name', dataTypeID: 25, dataTypeName: 'text' },
    { name: 'qty', dataTypeID: 1700, dataTypeName: 'numeric' },
  ],
  rows,
  rowCount: rows.length,
  durationMs: 1,
  command: 'SELECT',
  sql: 'select * from t',
  ...over,
});

const sourceTab = (rows: unknown[][]) => ({
  id: 'src',
  title: 'query-1.sql',
  kind: 'sql' as const,
  sql: 'select * from t',
  queryRunState: 'idle' as const,
  queryResult: res(rows),
  queryError: null,
  queryErrorSql: null,
  queryResults: [],
  queryGeneration: 1,
  page: 0,
  pageSize: 50,
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
});

const settle = async (tabId: string, phase = 'done') => {
  for (let i = 0; i < 60; i++) {
    if (useCompare.getState().sessions[tabId]?.phase === phase) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`never reached ${phase}: ${useCompare.getState().sessions[tabId]?.phase}`);
};

describe('compare store (C2)', () => {
  beforeEach(() => {
    // updateSettings applies the theme to `document`, which node tests don't have.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    compareRun.mockReset();
    exportSave.mockReset();
    settingsSet.mockReset();
    settingsSet.mockImplementation(async (patch: unknown) => ({ ...(patch as object) }));
    useCompare.setState({ sessions: {} });
    useSession.setState({
      tabs: [
        sourceTab([
          [1, 'a', '1.0'],
          [2, 'b', '2.0'],
          [3, 'c', '3.0'],
        ]),
      ],
      activeTabId: 'src',
      activeConfig: { id: 'stg', name: 'staging', engine: 'postgres' } as never,
      savedConnections: [
        { id: 'stg', name: 'staging', engine: 'postgres' },
        { id: 'prod', name: 'production', engine: 'postgres' },
      ] as never,
      schema: null,
    });
  });

  it('a tab result against the same query on another connection: diff, key and title', async () => {
    compareRun.mockResolvedValue(
      res([
        [1, 'a', '1.0'],
        [2, 'B', '2.0'],
        [4, 'd', '4.0'],
      ]),
    );
    const id = useCompare
      .getState()
      .open(
        { kind: 'tab', tabId: 'src' },
        { kind: 'query', connectionId: 'prod', sql: 'select * from t' },
      );
    await settle(id);
    const s = useCompare.getState().sessions[id]!;
    expect(compareRun).toHaveBeenCalledWith({
      connectionId: 'prod',
      sql: 'select * from t',
      maxRows: 200_000,
    });
    expect(s.a).toMatchObject({ origin: 'tab', connectionName: 'staging', rowCount: 3 });
    expect(s.b).toMatchObject({ origin: 'query', connectionName: 'production', rowCount: 3 });
    expect(s.options.keys).toEqual(['id']);
    expect(s.result?.summary).toEqual({
      added: 1,
      removed: 1,
      changed: 1,
      unchanged: 1,
      duplicates: 0,
    });
    // The compare tab is a real tab, titled by what it compares.
    const tab = useSession.getState().tabs.find((t) => t.id === id);
    expect(tab).toMatchObject({ kind: 'result-compare', title: 'staging vs production' });
  });

  it('changing an option re-compares; a manual key stops auto-suggestion', async () => {
    compareRun.mockResolvedValue(
      res([
        [1, 'A', '1.0'],
        [2, 'b', '2.0'],
        [3, 'c', '3.0'],
      ]),
    );
    const id = useCompare
      .getState()
      .open(
        { kind: 'tab', tabId: 'src' },
        { kind: 'query', connectionId: null, sql: 'select * from t' },
      );
    await settle(id);
    expect(useCompare.getState().sessions[id]!.result?.summary.changed).toBe(1);
    useCompare.getState().setOptions(id, { ignoreCase: true });
    await new Promise((r) => setTimeout(r, 400));
    await settle(id);
    expect(useCompare.getState().sessions[id]!.result?.summary.changed).toBe(0);
    useCompare.getState().setOptions(id, { keys: ['name'] });
    expect(useCompare.getState().sessions[id]!.keysChosen).toBe(true);
  });

  it('swap exchanges the sides and keeps the chosen key', async () => {
    compareRun.mockResolvedValue(
      res([
        [1, 'a', '1.0'],
        [9, 'z', '9.0'],
      ]),
    );
    const id = useCompare
      .getState()
      .open(
        { kind: 'tab', tabId: 'src' },
        { kind: 'query', connectionId: 'prod', sql: 'select * from t' },
      );
    await settle(id);
    useCompare.getState().swap(id);
    await new Promise((r) => setTimeout(r, 400));
    await settle(id);
    const s = useCompare.getState().sessions[id]!;
    expect(s.a.origin).toBe('query');
    expect(s.b.origin).toBe('tab');
    expect(s.result?.summary.added).toBe(2);
    expect(s.result?.summary.removed).toBe(1);
  });

  it('a failed side shows the readable reason and the other side is untouched', async () => {
    compareRun.mockRejectedValue(
      new Error(
        "Error invoking remote method 'plasma:compare:run': Error: rejected: only one read-only statement is allowed",
      ),
    );
    const id = useCompare
      .getState()
      .open(
        { kind: 'tab', tabId: 'src' },
        { kind: 'query', connectionId: 'prod', sql: 'delete from t' },
      );
    await new Promise((r) => setTimeout(r, 100));
    const s = useCompare.getState().sessions[id]!;
    expect(s.b.status).toBe('error');
    expect(s.b.error).toMatch(/only one read-only statement/);
    expect(s.b.error).toMatch(/SELECT, WITH, SHOW or EXPLAIN/);
    expect(s.b.error).not.toMatch(/Error invoking/);
    expect(s.a.status).toBe('ready');
    expect(s.result).toBeNull();
  });

  it('an older run of a side never overwrites a newer one', async () => {
    let first!: (v: unknown) => void;
    compareRun
      .mockReturnValueOnce(
        new Promise((r) => {
          first = r;
        }),
      )
      .mockResolvedValueOnce(res([[1, 'new', '1.0']]));
    const id = useCompare.getState().open({ kind: 'tab', tabId: 'src' });
    useCompare.getState().setSide(id, 'b', { kind: 'query', connectionId: null, sql: 'select 1' });
    useCompare.getState().setSide(id, 'b', { kind: 'query', connectionId: null, sql: 'select 2' });
    await new Promise((r) => setTimeout(r, 50));
    first(res([[1, 'old', '1.0']]));
    await new Promise((r) => setTimeout(r, 50));
    const rows = useCompare.getState().sessions[id]!.b.source?.rows;
    expect(rows).toEqual([[1, 'new', '1.0']]);
  });

  it('flags a truncated side', async () => {
    compareRun.mockResolvedValue(res([[1, 'a', '1.0']], { truncated: true }));
    const id = useCompare
      .getState()
      .open(
        { kind: 'tab', tabId: 'src' },
        { kind: 'query', connectionId: null, sql: 'select * from t' },
      );
    await settle(id);
    expect(useCompare.getState().sessions[id]!.b.truncated).toBe(true);
  });

  it('closing the compare tab frees its rows', async () => {
    const id = useCompare.getState().open({ kind: 'tab', tabId: 'src' });
    expect(useCompare.getState().sessions[id]).toBeDefined();
    useSession.setState((st) => ({ tabs: st.tabs.filter((t) => t.id !== id) }));
    expect(useCompare.getState().sessions[id]).toBeUndefined();
  });

  it('saves a definition (queries, connections, key, options) and loads it back', async () => {
    compareRun.mockResolvedValue(res([[1, 'a', '1.0']]));
    const id = useCompare
      .getState()
      .open(
        { kind: 'tab', tabId: 'src' },
        { kind: 'query', connectionId: 'prod', sql: 'select * from t' },
      );
    await settle(id);
    useCompare.getState().setOptions(id, { ignore: ['qty'], tolerance: 0.5 });
    useCompare.getState().save(id, 'stg vs prod');
    const saved = useSession.getState().settings.savedComparisons as Array<Record<string, unknown>>;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      name: 'stg vs prod',
      a: { connectionId: 'stg', sql: 'select * from t' },
      b: { connectionId: 'prod', sql: 'select * from t' },
      options: { keys: ['id'], ignore: ['qty'], tolerance: 0.5 },
    });
    // Load into a fresh compare tab: both queries run again.
    compareRun.mockClear();
    const fresh = useCompare.getState().open();
    const { parseSavedComparison } = await import('@shared/result-compare');
    useCompare.getState().load(fresh, parseSavedComparison(saved[0])!);
    await settle(fresh);
    expect(compareRun).toHaveBeenCalledTimes(2);
    expect(useCompare.getState().sessions[fresh]!.options.ignore).toEqual(['qty']);
    // Saving again updates in place.
    useCompare.getState().save(fresh, 'renamed');
    expect(useSession.getState().settings.savedComparisons).toHaveLength(1);
  });

  it('a saved side on a deleted connection falls back to the active one', async () => {
    compareRun.mockResolvedValue(res([[1, 'a', '1.0']]));
    const fresh = useCompare.getState().open();
    useCompare.getState().load(fresh, {
      id: 'x',
      name: 'old',
      a: { connectionId: 'gone', sql: 'select 1' },
      b: { connectionId: 'prod', sql: 'select 1' },
      options: { keys: [], ignore: [], tolerance: 0, ignoreCase: false, trimWhitespace: false },
      savedAt: 1,
    });
    await settle(fresh);
    expect(compareRun.mock.calls[0]![0]).toMatchObject({ connectionId: null });
  });

  it('exports the shown kinds through the save dialog', async () => {
    compareRun.mockResolvedValue(
      res([
        [1, 'a', '1.0'],
        [2, 'x', '2.0'],
        [4, 'd', '4.0'],
      ]),
    );
    exportSave.mockResolvedValue({
      ok: true,
      filePath: '/tmp/d.csv',
      rowCount: 2,
      bytesWritten: 10,
    });
    const id = useCompare
      .getState()
      .open(
        { kind: 'tab', tabId: 'src' },
        { kind: 'query', connectionId: null, sql: 'select * from t' },
      );
    await settle(id);
    await useCompare.getState().exportDiff(id, 'csv');
    const req = exportSave.mock.calls[0]![0] as {
      format: string;
      columns: Array<{ name: string }>;
      rows: unknown[][];
    };
    expect(req.format).toBe('csv');
    expect(req.columns.map((c) => c.name).slice(0, 3)).toEqual(['diff', 'changed_columns', 'id']);
    expect(req.rows.map((r) => r[0])).toEqual(['changed', 'removed', 'added']);
    expect(useCompare.getState().sessions[id]!.exportNote).toMatch(/Exported 2 rows/);
  });
});
