import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryRun = vi.fn();
const updateSettings = vi.fn(async (_patch: Record<string, unknown>) => undefined);

vi.mock('@/lib/ipc', () => ({
  ipc: {
    query: { run: (...args: unknown[]) => queryRun(...args), cancel: vi.fn(async () => undefined) },
    sql: { format: vi.fn() },
    conn: { test: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), introspect: vi.fn() },
    settings: { get: vi.fn(), set: vi.fn(async () => undefined) },
    history: { list: vi.fn(async () => []), clear: vi.fn() },
    txn: { begin: vi.fn(), commit: vi.fn(), rollback: vi.fn() },
    ai: { chat: vi.fn(), cancel: vi.fn() },
  },
}));

import { useSession } from './session';
import { ensureVariablesReady, setQueryVar } from './session-variables';

const result = {
  columns: [{ name: 'c', dataTypeID: 23, dataTypeName: 'int4' }],
  rows: [[1]],
  rowCount: 1,
  command: 'SELECT',
  durationMs: 1,
};

function seed(sql: string, extra: Record<string, unknown> = {}, tag?: 'prod') {
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
        ...extra,
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
      connectionTags: tag ? { c1: tag } : {},
      variableHistory: {},
    },
    prodGate: null,
    updateSettings,
  });
}

const tab = () => useSession.getState().tabs[0]!;

describe('query variables in runQuery', () => {
  beforeEach(() => {
    queryRun.mockReset();
    queryRun.mockResolvedValue(result);
    updateSettings.mockClear();
  });

  it('opens the Variables bar instead of running when a value is missing', async () => {
    seed('select * from t where id = :id');
    await useSession.getState().runQuery();
    expect(queryRun).not.toHaveBeenCalled();
    expect(tab().varsBarOpen).toBe(true);
    expect(tab().varsAttention).toBe('Fill in :id first');
  });

  it('stops once for review even when values exist (saved defaults), then runs', async () => {
    seed('select :id::int', { queryVars: { id: { mode: 'number', value: '5' } } });
    await useSession.getState().runQuery();
    expect(queryRun).not.toHaveBeenCalled();
    expect(tab().varsBarOpen).toBe(true);
    setQueryVar('tab-a', 'id', { mode: 'number', value: '5' });
    await useSession.getState().runQuery();
    expect(queryRun).toHaveBeenCalledWith('select $1::int', ['5']);
  });

  it('binds values as parameters for Run All, per statement, and keeps the original SQL on results', async () => {
    seed('select :a::int; select :b::text, :a::int', {});
    setQueryVar('tab-a', 'a', { mode: 'number', value: '1' });
    setQueryVar('tab-a', 'b', { mode: 'text', value: "o'k" });
    await useSession.getState().runQuery({ all: true });
    expect(queryRun).toHaveBeenNthCalledWith(1, 'select $1::int', ['1']);
    expect(queryRun).toHaveBeenNthCalledWith(2, 'select $1::text, $2::int', ["o'k", '1']);
    expect(tab().queryResults.map((r: { sql?: string }) => r.sql)).toEqual([
      'select :a::int',
      'select :b::text, :a::int',
    ]);
  });

  it('Run Selected only needs the variables in the selection', async () => {
    seed('select :a; select :b');
    setQueryVar('tab-a', 'a', { mode: 'text', value: 'x' });
    useSession.setState({ carets: {} } as never);
    await useSession.getState().runQuery({ sql: 'select :a', base: 0 });
    expect(queryRun).toHaveBeenCalledWith('select $1', ['x']);
  });

  it('rejects a value of the wrong type without running', async () => {
    seed('select :n');
    setQueryVar('tab-a', 'n', { mode: 'number', value: 'abc' });
    await useSession.getState().runQuery();
    expect(queryRun).not.toHaveBeenCalled();
    expect(tab().varsAttention).toBe(':n — Enter a number');
  });

  it('pastes raw SQL and binds the rest', async () => {
    seed('select * from :tbl where id = :id');
    setQueryVar('tab-a', 'tbl', { mode: 'raw', value: 'public.users' });
    setQueryVar('tab-a', 'id', { mode: 'number', value: '9' });
    await useSession.getState().runQuery();
    expect(queryRun).toHaveBeenCalledWith('select * from public.users where id = $1', ['9']);
  });

  it('the prod gate sees the statement with raw values written out', async () => {
    seed('select * from t where id = :id; :stmt', {}, 'prod');
    setQueryVar('tab-a', 'id', { mode: 'number', value: '1' });
    setQueryVar('tab-a', 'stmt', { mode: 'raw', value: 'delete from users' });
    await useSession.getState().runQuery({ all: true });
    expect(queryRun).not.toHaveBeenCalled();
    expect(useSession.getState().prodGate?.sql).toContain('delete from users');
    expect(useSession.getState().prodGate?.sql).toContain('id = 1');
  });

  it('remembers used values in the per-variable history', async () => {
    seed('select :a');
    setQueryVar('tab-a', 'a', { mode: 'text', value: 'first' });
    await useSession.getState().runQuery();
    expect(updateSettings).toHaveBeenCalledWith({ variableHistory: { a: ['first'] } });
  });

  it('ensureVariablesReady gates Explain / Safe Run the same way', () => {
    seed('select :a');
    expect(ensureVariablesReady(tab(), 'select 1')).toBe(true);
    expect(ensureVariablesReady(tab(), 'select :a')).toBe(false);
    expect(tab().varsBarOpen).toBe(true);
    setQueryVar('tab-a', 'a', { mode: 'text', value: 'x' });
    expect(ensureVariablesReady(tab(), 'select :a')).toBe(true);
  });
});
