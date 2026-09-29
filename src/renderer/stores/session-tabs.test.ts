import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryTab } from './session';
import {
  duplicateTitle,
  installTabPersistence,
  isPreviewTab,
  isTabDirty,
  loadPersistedTabs,
  nextSqlTabTitle,
  parsePersistedTabs,
  restoreTabs,
  serializeTabs,
} from './session-tabs';

function tab(partial: Partial<QueryTab>): QueryTab {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    title: 'query-1.sql',
    kind: 'sql',
    sql: '',
    queryRunState: 'idle',
    queryResult: null,
    queryError: null,
    queryErrorSql: null,
    page: 0,
    pageSize: 50,
    selectedCell: null,
    selectedRows: new Set(),
    columnWidths: {},
    sortColumn: null,
    tableSort: [],
    filters: [],
    hiddenColumns: new Set(),
    stickyColumns: new Set(),
    totalRowCount: null,
    totalRowCountIsEstimate: false,
    countLoading: false,
    viewMode: 'data',
    rlsPolicyCount: null,
    ...partial,
  } as QueryTab;
}

describe('tab naming (D3 / VF17)', () => {
  it('numbers SQL tabs among themselves, ignoring table tabs', () => {
    const tabs = [
      tab({ title: 'query-1.sql' }),
      tab({ kind: 'table', title: 'orders' }),
      tab({ kind: 'table', title: 'users' }),
    ];
    expect(nextSqlTabTitle(tabs)).toBe('query-2.sql');
  });

  it('never repeats an open number after a close', () => {
    // query-2 was closed; query-3 is still open.
    const tabs = [tab({ title: 'query-1.sql' }), tab({ title: 'query-3.sql' })];
    expect(nextSqlTabTitle(tabs)).toBe('query-4.sql');
    expect(nextSqlTabTitle([])).toBe('query-1.sql');
  });

  it('gives duplicates a unique suffix', () => {
    const tabs = [tab({ title: 'report.sql' }), tab({ title: 'report (2).sql' })];
    expect(duplicateTitle('report.sql', tabs)).toBe('report (3).sql');
    expect(duplicateTitle('orders', [tab({ title: 'orders' })])).toBe('orders (2)');
  });
});

describe('dirty and preview rules', () => {
  it('treats unsaved SQL as dirty, empty scratch tabs as clean', () => {
    expect(isTabDirty(tab({ sql: '' }))).toBe(false);
    expect(isTabDirty(tab({ sql: 'select 1' }))).toBe(true);
    expect(isTabDirty(tab({ sql: 'select 1', cleanSql: 'select 1' }))).toBe(false);
    expect(isTabDirty(tab({ sql: '', cleanSql: 'select 1', fileName: 'a.sql' }))).toBe(true);
    expect(isTabDirty(tab({ kind: 'table', sql: 'SELECT * FROM t' }))).toBe(false);
  });

  it('keeps a preview tab only while untouched', () => {
    const p = tab({ id: 'p', kind: 'table', preview: true });
    expect(isPreviewTab(p)).toBe(true);
    expect(isPreviewTab({ ...p, page: 2 })).toBe(false);
    expect(
      isPreviewTab({
        ...p,
        filters: [{ id: 'f', column: 'a', op: '=', value: '1' }] as QueryTab['filters'],
      }),
    ).toBe(false);
    expect(isPreviewTab({ ...p, viewMode: 'structure' })).toBe(false);
    expect(isPreviewTab(p, new Set(['p']))).toBe(false);
    expect(isPreviewTab({ ...p, preview: false })).toBe(false);
  });
});

describe('tab persistence (D1)', () => {
  const tabs = [
    tab({ id: 'a', title: 'query-1.sql', sql: 'select 1', cleanSql: '' }),
    tab({
      id: 'b',
      kind: 'table',
      title: 'orders',
      tableSchema: 'public',
      tableName: 'orders',
      filters: [{ id: 'f1', column: 'id', op: '=', value: '3' }] as QueryTab['filters'],
      tableSort: [{ column: 'id', direction: 'desc' }],
      viewMode: 'structure',
    }),
    tab({ id: 'c', kind: 'redis-key', title: 'k' }),
    tab({
      id: 'd',
      title: 'report.sql',
      sql: 'select 2',
      cleanSql: 'select 2',
      fileName: 'report.sql',
    }),
  ];

  it('round-trips SQL and table tabs and the active tab', () => {
    const data = serializeTabs(tabs, 'd');
    expect(data.tabs.map((t) => t.title)).toEqual(['query-1.sql', 'orders', 'report.sql']);
    expect(data.activeIndex).toBe(2);
    const json = JSON.parse(JSON.stringify(data));
    const parsed = parsePersistedTabs(json);
    expect(parsed).not.toBeNull();
    let n = 0;
    const restored = restoreTabs(
      parsed!,
      (title) => tab({ id: `s${n++}`, title }),
      (schema, name) =>
        tab({ id: `t${n++}`, kind: 'table', title: name, tableSchema: schema, tableName: name }),
    );
    expect(restored.tabs).toHaveLength(3);
    expect(restored.tabs[0]).toMatchObject({ kind: 'sql', sql: 'select 1', cleanSql: '' });
    expect(restored.tabs[1]).toMatchObject({
      kind: 'table',
      tableName: 'orders',
      viewMode: 'structure',
      tableSort: [{ column: 'id', direction: 'desc' }],
    });
    expect(restored.tabs[1]!.filters[0]).toMatchObject({ column: 'id', value: '3' });
    expect(restored.tabs[2]).toMatchObject({ fileName: 'report.sql', cleanSql: 'select 2' });
    expect(restored.activeTabId).toBe(restored.tabs[2]!.id);
    // Restored buffers keep their dirty state.
    expect(isTabDirty(restored.tabs[0]!)).toBe(true);
    expect(isTabDirty(restored.tabs[2]!)).toBe(false);
  });

  it('rejects malformed payloads', () => {
    expect(parsePersistedTabs(null)).toBeNull();
    expect(parsePersistedTabs({ v: 2, tabs: [] })).toBeNull();
    expect(parsePersistedTabs({ v: 1, tabs: [{ kind: 'sql' }] })).toBeNull();
    expect(
      parsePersistedTabs({ v: 1, activeIndex: 9, tabs: [{ kind: 'sql', title: 'x', sql: '' }] })
        ?.activeIndex,
    ).toBe(0);
  });
});

describe('installTabPersistence', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    vi.useFakeTimers();
    store.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function fakeStore(initial: Record<string, unknown>) {
    let state = initial as never as {
      tabs: QueryTab[];
      activeTabId: string;
      tabsConnectionId: string | null;
      activeConfig: { id?: string; engine?: string } | null;
    };
    const listeners: Array<(s: typeof state, p: typeof state) => void> = [];
    return {
      getState: () => state,
      subscribe: (l: (s: typeof state, p: typeof state) => void) => {
        listeners.push(l);
        return () => undefined;
      },
      set(patch: Partial<typeof state>) {
        const prev = state;
        state = { ...state, ...patch };
        for (const l of listeners) l(state, prev);
      },
    };
  }

  it('debounces writes per connection and skips unadopted tabs', () => {
    const s = fakeStore({
      tabs: [],
      activeTabId: '',
      tabsConnectionId: null,
      activeConfig: { id: 'c1' },
    });
    const stop = installTabPersistence(s);
    s.set({ tabs: [tab({ id: 'x', sql: 'select 9' })], activeTabId: 'x' });
    vi.advanceTimersByTime(1000);
    expect(store.size).toBe(0); // tabs not adopted for c1 yet
    s.set({ tabsConnectionId: 'c1', tabs: [tab({ id: 'x', sql: 'select 10' })] });
    expect(store.size).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(loadPersistedTabs('c1')?.tabs[0]?.sql).toBe('select 10');
    stop();
  });
});
