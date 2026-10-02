import { beforeEach, describe, expect, it, vi } from 'vitest';

const commitEditBatch = vi.fn();
const saveSqlFile = vi.fn(async () => 'q.sql');

vi.mock('@/features/editor/sql-files', () => ({
  fileNameForTitle: (t: string) => t,
  pickSqlFile: vi.fn(),
  rememberFileHandle: vi.fn(),
  saveSqlFile: (...a: unknown[]) => saveSqlFile(...(a as [])),
}));
vi.mock('@/lib/ipc', () => ({
  ipc: {
    query: {
      run: vi.fn(),
      commitEditBatch: (...a: unknown[]) => commitEditBatch(...a),
      cancel: vi.fn(async () => undefined),
    },
    settings: { get: vi.fn(), set: vi.fn(async () => undefined) },
    conn: { introspect: vi.fn(async () => ({})) },
    vault: { list: vi.fn(async () => []) },
    history: { list: vi.fn(async () => []) },
  },
}));

import { useSession } from '@/stores/session';
import { runCommand } from './commands';

const edit = {
  id: 'e1',
  tabId: 'tab-table',
  schema: 'public',
  table: 'users',
  kind: 'update' as const,
  pkValues: { id: '1' },
  rowKey: '[["id","1"]]',
  column: 'email',
  oldValue: 'a',
  newValue: 'b',
  rowIndex: 0,
  columnIndex: 1,
  connectionGen: 1,
};

function tab(id: string, kind: 'sql' | 'table') {
  const pageSize = useSession.getState().settings.defaultPageSize;
  return {
    id,
    title: `${id}.sql`,
    kind,
    sql: kind === 'sql' ? 'select 1' : '',
    queryRunState: 'idle',
    queryResult: null,
    queryError: null,
    page: 0,
    pageSize,
    filters: [],
    tableSort: [],
    hiddenColumns: new Set<string>(),
    stickyColumns: new Set<string>(),
    selectedRows: new Set<number>(),
    columnWidths: {},
    viewMode: 'data',
    ...(kind === 'table' ? { tableSchema: 'public', tableName: 'users' } : {}),
  };
}

beforeEach(() => {
  commitEditBatch.mockReset();
  saveSqlFile.mockClear();
  useSession.setState({
    tabs: [tab('tab-table', 'table'), tab('tab-sql', 'sql')] as never,
    activeTabId: 'tab-sql',
    connectionState: 'connected',
    connectionGen: 1,
    activeConfig: { id: 'c', name: 'c', engine: 'postgres' } as never,
    pendingEditsByTab: { 'tab-table': [edit] },
    pendingEditsBusy: false,
  });
});

describe('commitEdits command (R-01)', () => {
  it('⌘S in a SQL tab saves the file and never commits another tab’s edits', async () => {
    expect(runCommand('commitEdits')).toBe(true);
    await vi.waitFor(() => expect(saveSqlFile).toHaveBeenCalledOnce());
    expect(commitEditBatch).not.toHaveBeenCalled();
    expect(useSession.getState().pendingEditsByTab['tab-table']).toHaveLength(1);
  });

  it('⌘S in the table tab commits that tab’s edits', async () => {
    useSession.setState({ activeTabId: 'tab-table' });
    commitEditBatch.mockResolvedValue({ state: 'none', applied: 1 });
    expect(runCommand('commitEdits')).toBe(true);
    await vi.waitFor(() => expect(commitEditBatch).toHaveBeenCalledOnce());
    expect(saveSqlFile).not.toHaveBeenCalled();
  });

  it('does nothing in a table tab with no staged edits', () => {
    useSession.setState({ activeTabId: 'tab-table', pendingEditsByTab: {} });
    expect(runCommand('commitEdits')).toBe(false);
    expect(commitEditBatch).not.toHaveBeenCalled();
  });
});
