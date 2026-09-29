import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryRun = vi.fn();
const queryCancel = vi.fn(async () => undefined);

vi.mock('@/lib/ipc', () => ({
  ipc: {
    query: {
      run: (...args: unknown[]) => queryRun(...args),
      cancel: () => queryCancel(),
    },
    sql: { format: vi.fn() },
    conn: {
      test: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      introspect: vi.fn(async () => ({ schemas: [], tables: [], columns: [], foreignKeys: [] })),
      introspectColumns: vi.fn(async () => ({ columns: [], foreignKeys: [] })),
    },
    settings: { get: vi.fn(), set: vi.fn(async (p: unknown) => p) },
    history: { list: vi.fn(async () => []), clear: vi.fn(), latest: vi.fn() },
    txn: { begin: vi.fn(), commit: vi.fn(), rollback: vi.fn() },
    ai: { chat: vi.fn(), cancel: vi.fn() },
  },
}));

import { useSession } from './session';
import { useWorkbench } from './workbench';

const result = (n: number) => ({
  columns: [{ name: 'n', dataTypeId: 23 }],
  rows: [[n]],
  rowCount: 1,
  command: 'SELECT',
  durationMs: 1,
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function reset() {
  const s = useSession.getState();
  s.closeTabsNow(s.tabs.map((t) => t.id));
  useSession.setState({
    connectionState: 'connected',
    connectionGen: 1,
    activeConfig: { id: 'c1', engine: 'postgres' } as never,
    pendingEdits: [],
    closeTabsRequest: null,
    canvasMode: 'database',
    rightPanelMode: 'details',
  });
  queryRun.mockReset();
  queryRun.mockResolvedValue(result(0));
}

beforeEach(reset);

describe('tabs in the session store', () => {
  it('numbers new SQL tabs without duplicates (D3)', () => {
    const s = useSession.getState();
    s.addTab();
    s.addTab();
    const titles = useSession.getState().tabs.map((t) => t.title);
    expect(titles).toEqual(['query-1.sql', 'query-2.sql', 'query-3.sql']);
    useSession.getState().closeTab(useSession.getState().tabs[1]!.id);
    useSession.getState().addTab();
    expect(useSession.getState().tabs.map((t) => t.title)).toEqual([
      'query-1.sql',
      'query-3.sql',
      'query-4.sql',
    ]);
  });

  it('replaces an untouched preview tab and keeps pinned ones (VF17)', () => {
    const s = useSession.getState();
    s.openTable('public', 'a');
    s.openTable('public', 'b');
    let tabs = useSession.getState().tabs;
    expect(tabs.map((t) => t.title)).toEqual(['query-1.sql', 'b']);
    expect(tabs[1]!.preview).toBe(true);

    useSession.getState().pinTab(tabs[1]!.id);
    useSession.getState().openTable('public', 'c');
    tabs = useSession.getState().tabs;
    expect(tabs.map((t) => t.title)).toEqual(['query-1.sql', 'b', 'c']);

    // Paging pins implicitly: the next preview open adds a tab.
    useSession.getState().setPage(1);
    useSession.getState().openTable('public', 'd', { preview: false });
    expect(useSession.getState().tabs.map((t) => t.title)).toEqual(['query-1.sql', 'b', 'c', 'd']);
  });

  it('asks before closing unsaved SQL, closes clean tabs directly (D1)', () => {
    const s = useSession.getState();
    s.addTab();
    const [clean, dirty] = useSession.getState().tabs;
    useSession.getState().setSql('select 1');
    useSession.getState().requestCloseTabs([dirty!.id]);
    expect(useSession.getState().closeTabsRequest).toEqual({
      ids: [dirty!.id],
      dirtyTitles: ['query-2.sql'],
    });
    useSession.getState().cancelCloseTabs();
    expect(useSession.getState().tabs).toHaveLength(2);

    useSession.getState().requestCloseTabs([clean!.id]);
    expect(useSession.getState().tabs.map((t) => t.id)).toEqual([dirty!.id]);

    useSession.getState().closeAllTabs();
    useSession.getState().confirmCloseTabs();
    const after = useSession.getState().tabs;
    expect(after).toHaveLength(1);
    expect(after[0]!.sql).toBe('');
  });

  it('closes others / to the right and duplicates tabs (D2)', () => {
    const s = useSession.getState();
    s.addTab();
    s.addTab();
    const ids = useSession.getState().tabs.map((t) => t.id);
    useSession.getState().closeTabsToRight(ids[0]!);
    expect(useSession.getState().tabs.map((t) => t.id)).toEqual([ids[0]]);
    useSession.getState().setSql('select 42');
    useSession.getState().duplicateTab(ids[0]!);
    const tabs = useSession.getState().tabs;
    expect(tabs[1]).toMatchObject({ sql: 'select 42', title: 'query-1 (2).sql' });
    useSession.getState().renameTab(tabs[1]!.id, '  report  ');
    expect(useSession.getState().tabs[1]!.title).toBe('report');
    useSession.getState().closeOtherTabs(tabs[1]!.id);
    useSession.getState().confirmCloseTabs();
    expect(useSession.getState().tabs.map((t) => t.title)).toEqual(['report']);
  });

  it('opens history in a new tab without touching the sidebar (E1)', () => {
    useSession.getState().setSql('keep me');
    useSession.setState({ canvasMode: 'history', rightPanelMode: 'ai' });
    useSession.getState().reuseHistoryQuery('select now()');
    const st = useSession.getState();
    expect(st.tabs).toHaveLength(2);
    expect(st.tabs[0]!.sql).toBe('keep me');
    expect(st.tabs[1]!.sql).toBe('select now()');
    expect(st.activeTabId).toBe(st.tabs[1]!.id);
    expect(st.canvasMode).toBe('database');
    expect(st.rightPanelMode).toBe('ai');
  });

  it('toggles the inline editor for SQL tabs (⌘J)', () => {
    useWorkbench.setState({ editorHidden: false });
    useSession.getState().toggleEditor();
    expect(useWorkbench.getState().editorHidden).toBe(true);
    useSession.getState().toggleEditor();
    expect(useWorkbench.getState().editorHidden).toBe(false);
    expect(useSession.getState().rightPanelMode).toBe('details');
  });

  it('drops stale table data responses (B1)', async () => {
    const first = deferred<ReturnType<typeof result>>();
    queryRun.mockImplementation((sql: string) =>
      /count/i.test(sql) ? Promise.resolve(result(0)) : first.promise,
    );
    useSession.getState().openTable('public', 'orders', { preview: false });
    const tabId = useSession.getState().activeTabId;
    // A newer page request supersedes the first one.
    queryRun.mockImplementation((sql: string) =>
      Promise.resolve(/count/i.test(sql) ? result(0) : result(2)),
    );
    useSession.getState().setPage(1);
    await vi.waitFor(() => {
      const t = useSession.getState().tabs.find((x) => x.id === tabId);
      expect(t?.queryResult?.rows[0]?.[0]).toBe(2);
    });
    first.resolve(result(1));
    await first.promise;
    await Promise.resolve();
    const t = useSession.getState().tabs.find((x) => x.id === tabId);
    expect(t?.queryResult?.rows[0]?.[0]).toBe(2);
  });

  it('drops a table response from a previous connection generation (B1)', async () => {
    const pending = deferred<ReturnType<typeof result>>();
    queryRun.mockImplementation((sql: string) =>
      /count/i.test(sql) ? Promise.resolve(result(0)) : pending.promise,
    );
    useSession.getState().openTable('public', 'orders', { preview: false });
    const tabId = useSession.getState().activeTabId;
    useSession.setState({ connectionGen: 2 });
    pending.resolve(result(7));
    await pending.promise;
    await Promise.resolve();
    expect(useSession.getState().tabs.find((x) => x.id === tabId)?.queryResult).toBeNull();
  });

  it('clears per-statement results on worker reset (B6)', () => {
    useSession.setState((s) => ({
      tabs: s.tabs.map((t) => ({
        ...t,
        queryResult: result(1),
        queryResults: [result(1), result(2)],
        queryNotices: [{ statementIndex: 0, notice: { message: 'x' } }],
      })),
    }));
    useSession.getState().handleWorkerReset();
    const t = useSession.getState().tabs[0]!;
    expect(t.queryResult).toBeNull();
    expect(t.queryResults).toEqual([]);
    expect(t.queryNotices).toEqual([]);
  });

  it('refuses psql meta-commands with a clear error', async () => {
    useSession.getState().setSql('\\dt');
    await useSession.getState().runQuery({ all: true });
    expect(queryRun).not.toHaveBeenCalled();
    expect(useSession.getState().tabs[0]!.queryError).toMatch(/meta-commands/);
  });
});
