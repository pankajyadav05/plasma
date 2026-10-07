import {
  onRecoveryRestored,
  resetPendingRecoveries,
  setPendingRecoveries,
} from '@/lib/crash-recovery';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryTab } from './session';
import {
  MAX_SQL_CHARS,
  adoptConnectionTabs,
  duplicateTitle,
  flushPersistedTabs,
  installTabPersistence,
  isPreviewTab,
  isTabDirty,
  loadPersistedTabs,
  nextSqlTabTitle,
  parsePersistedTabs,
  restoreTabs,
  restoreTabsOnceFor,
  serializeTabs,
  unrestorableDirtyTabs,
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

describe('flushPersistedTabs (update restart)', () => {
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

  it('writes the pending tab strip at once instead of after the debounce', () => {
    type S = {
      tabs: QueryTab[];
      activeTabId: string;
      tabsConnectionId: string | null;
      activeConfig: { id?: string; engine?: string } | null;
    };
    let state: S = {
      tabs: [],
      activeTabId: '',
      tabsConnectionId: 'c1',
      activeConfig: { id: 'c1' },
    };
    const listeners: Array<(s: S, p: S) => void> = [];
    const stop = installTabPersistence({
      getState: () => state,
      subscribe: (l) => {
        listeners.push(l);
        return () => undefined;
      },
    });
    const prev = state;
    state = { ...state, tabs: [tab({ id: 'x', sql: 'select unsaved' })], activeTabId: 'x' };
    for (const l of listeners) l(state, prev);
    expect(store.size).toBe(0);

    flushPersistedTabs();

    expect(loadPersistedTabs('c1')?.tabs[0]?.sql).toBe('select unsaved');
    stop();
    expect(() => flushPersistedTabs()).not.toThrow();
  });
});

describe('unrestorableDirtyTabs', () => {
  const live = { activeConfig: { id: 'c1', engine: 'postgres' }, tabsConnectionId: 'c1' };

  it('is zero when every dirty tab is written to disk', () => {
    expect(
      unrestorableDirtyTabs({
        ...live,
        tabs: [tab({ sql: 'select 1' }), tab({ sql: '', cleanSql: '' })],
      }),
    ).toBe(0);
  });

  it('counts a buffer that persistence skips for being too large', () => {
    expect(
      unrestorableDirtyTabs({
        ...live,
        tabs: [tab({ sql: 'x'.repeat(MAX_SQL_CHARS + 1) }), tab({ sql: 'select 1' })],
      }),
    ).toBe(1);
  });

  it('counts every dirty tab when nothing is persisted (no live SQL connection)', () => {
    const tabs = [tab({ sql: 'select 1' }), tab({ sql: 'select 2' }), tab({ sql: '' })];
    expect(unrestorableDirtyTabs({ activeConfig: null, tabsConnectionId: null, tabs })).toBe(2);
    expect(
      unrestorableDirtyTabs({
        activeConfig: { id: 'r', engine: 'redis' },
        tabsConnectionId: 'r',
        tabs,
      }),
    ).toBe(2);
    // tabs adopted for another connection are not saved under this one
    expect(unrestorableDirtyTabs({ ...live, tabsConnectionId: 'other', tabs })).toBe(2);
  });
});

describe('restoring tabs after an update restart', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    });
    store.set(
      'plasma.tabs.v1.c1',
      JSON.stringify({
        v: 1,
        activeIndex: 1,
        tabs: [
          { kind: 'sql', title: 'query-1.sql', sql: 'select 1' },
          { kind: 'sql', title: 'query-2.sql', sql: 'select unsaved' },
        ],
      }),
    );
  });
  afterEach(() => {
    restoreTabsOnceFor(null);
    vi.unstubAllGlobals();
  });

  function adopt(restoreSetting: boolean, connectionId = 'c1') {
    let state = {
      activeConfig: { id: connectionId },
      tabsConnectionId: null as string | null,
      tabs: [tab({ id: 'start' })],
      activeTabId: 'start',
      settings: { restoreWorkspace: restoreSetting, defaultPageSize: 50 },
      setActiveTab: vi.fn(),
    };
    const set = (patch: Record<string, unknown>) => {
      state = { ...state, ...patch } as typeof state;
    };
    adoptConnectionTabs(set as never, (() => state) as never, 'postgres');
    return state;
  }

  it('leaves tabs alone when "Restore tabs on launch" is off', () => {
    expect(adopt(false).tabs.map((t) => t.id)).toEqual(['start']);
  });

  it('brings them back, active tab included, when the restart was an update', () => {
    restoreTabsOnceFor('c1');
    const state = adopt(false);
    expect(state.tabs.map((t) => t.sql)).toEqual(['select 1', 'select unsaved']);
    expect(state.activeTabId).toBe(state.tabs[1]?.id);
  });

  it('applies to that connection only, and only once', () => {
    restoreTabsOnceFor('c2');
    expect(adopt(false, 'c1').tabs.map((t) => t.id)).toEqual(['start']);
    restoreTabsOnceFor('c1');
    adopt(false, 'c1');
    expect(adopt(false, 'c1').tabs.map((t) => t.id)).toEqual(['start']);
  });
});

describe('restoring a crashed session (B2)', () => {
  const store = new Map<string, string>();
  const restored = vi.fn();
  beforeEach(() => {
    store.clear();
    restored.mockClear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    });
    // The older saved strip must lose to the newer crash snapshot.
    store.set(
      'plasma.tabs.v1.c1',
      JSON.stringify({ v: 1, activeIndex: 0, tabs: [{ kind: 'sql', title: 'old', sql: 'old' }] }),
    );
    onRecoveryRestored(restored);
  });
  afterEach(() => {
    onRecoveryRestored(null);
    resetPendingRecoveries();
    vi.unstubAllGlobals();
  });

  const edit = (tabIndex: number, over: Record<string, unknown> = {}) => ({
    tabIndex,
    kind: 'update' as const,
    schema: 'public',
    table: 'users',
    pkValues: { id: '1' },
    column: 'name',
    oldValue: 'ada',
    oldType: 'text',
    newValue: 'ADA',
    ...over,
  });

  function crashJournal(over: Record<string, unknown> = {}) {
    return {
      v: 1 as const,
      savedAt: 10,
      connectionId: 'c1',
      txnActive: true,
      strip: {
        v: 1 as const,
        activeIndex: 2,
        tabs: [
          { kind: 'sql', title: 'query-1.sql', sql: 'select unsaved', cleanSql: '' },
          { kind: 'sql', title: 'bad' }, // fails validation: skipped on restore
          { kind: 'table', title: 'users', tableSchema: 'public', tableName: 'users' },
        ],
      },
      edits: [edit(2)],
      ...over,
    };
  }

  function adopt(settingOn = false) {
    let state = {
      activeConfig: { id: 'c1' },
      connectionGen: 7,
      tabsConnectionId: null as string | null,
      tabs: [tab({ id: 'start' })],
      activeTabId: 'start',
      pendingEditsByTab: {},
      settings: { restoreWorkspace: settingOn, defaultPageSize: 50 },
      setActiveTab: vi.fn(),
    };
    const set = (patch: Record<string, unknown>) => {
      state = { ...state, ...patch } as typeof state;
    };
    adoptConnectionTabs(set as never, (() => state) as never, 'postgres');
    return state;
  }

  const setPending = (journals: unknown[]) =>
    setPendingRecoveries({
      unclean: true,
      cause: 'exit',
      journals: journals as never,
      hasLog: true,
    });

  it('brings back tabs with their unsaved SQL, even with "Restore tabs on launch" off', () => {
    setPending([crashJournal()]);
    const state = adopt(false);
    expect(state.tabs.map((t) => t.kind)).toEqual(['sql', 'table']);
    expect(state.tabs[0]?.sql).toBe('select unsaved');
    expect(state.tabsConnectionId).toBe('c1');
    expect(state.activeTabId).toBe(state.tabs[1]?.id);
  });

  it('re-stages edits on the right tab despite a skipped tab, stamped with the live generation', () => {
    setPending([crashJournal()]);
    const state = adopt();
    const tableTab = state.tabs[1] as QueryTab;
    const byTab = state.pendingEditsByTab as Record<string, Array<Record<string, unknown>>>;
    const edits = byTab[tableTab.id];
    expect(edits).toHaveLength(1);
    expect(edits?.[0]).toMatchObject({
      kind: 'update',
      column: 'name',
      oldValue: 'ada',
      newValue: 'ADA',
      connectionGen: 7,
      tabId: tableTab.id,
    });
  });

  it('tells the shell what came back, with the snapshot to resolve afterwards', () => {
    setPending([crashJournal()]);
    adopt();
    expect(restored).toHaveBeenCalledOnce();
    const arg = restored.mock.calls[0]?.[0];
    expect(arg).toMatchObject({ tabs: 2, edits: 1 });
    expect(arg.journal.connectionId).toBe('c1');
    expect(arg.journal.txnActive).toBe(true);
  });

  it('restores a snapshot once, and only for its own connection', () => {
    setPending([crashJournal()]);
    expect(adopt().tabs).toHaveLength(2);
    // a later adoption (e.g. another reconnect) starts from the normal path
    expect(adopt().tabs.map((t) => t.id)).toEqual(['start']);
    resetPendingRecoveries();
    setPending([crashJournal({ connectionId: 'other' })]);
    expect(adopt().tabs.map((t) => t.id)).toEqual(['start']);
    expect(restored).toHaveBeenCalledTimes(1);
  });

  it('an edit whose tab was unusable reopens its table instead of being lost', () => {
    setPending([
      crashJournal({
        strip: { v: 1, activeIndex: 0, tabs: [{ kind: 'sql', title: 'q', sql: 'select 1' }] },
        edits: [edit(9), edit(9, { column: 'age', oldValue: '1', newValue: '2' })],
      }),
    ]);
    const state = adopt();
    expect(state.tabs.map((t) => t.kind)).toEqual(['sql', 'table']);
    const reopened = state.tabs[1] as QueryTab;
    expect(reopened.tableName).toBe('users');
    const staged = (state.pendingEditsByTab as Record<string, unknown[]>)[reopened.id];
    expect(staged).toHaveLength(2);
    expect(restored.mock.calls[0]?.[0].edits).toBe(2);
  });

  it('edits with no usable tab strip still come back (fresh tab plus the table)', () => {
    setPending([crashJournal({ strip: { v: 1, activeIndex: 0, tabs: [{ kind: 'bogus' }] } })]);
    const state = adopt();
    expect(Object.values(state.pendingEditsByTab as object).flat()).toHaveLength(1);
  });

  it('a snapshot without edits restores tabs and stages nothing', () => {
    setPending([crashJournal({ edits: [], txnActive: false })]);
    const state = adopt();
    expect(Object.keys(state.pendingEditsByTab)).toEqual([]);
    expect(restored.mock.calls[0]?.[0].edits).toBe(0);
  });
});
