import { ipc } from '@/lib/ipc';
import type { Filter, TableSort } from '@/lib/table-query';
import type { ConnectionEngine } from '@shared/protocol';
import { editsOf, pendingEditCount, withoutTabEdits } from './session-pending-edits';
import { DEFAULT_SETTINGS } from './session-settings';
import { createEmptyTab, createTableTab, patchActiveTab, patchTabById } from './session-tab-model';
import { loadTableTab } from './session-table-query';
import type { QueryTab, SessionState, SliceCreator, TableViewMode } from './session-types';
import { useWorkbench } from './workbench';

/**
 * Tab bookkeeping that doesn't need the store: naming, dirty / preview
 * rules, and the per-connection persistence format (D1). The store in
 * `session.ts` composes these; everything here is pure or touches only
 * localStorage so it can be unit-tested without Electron.
 */

// ─── Naming (D3 / VF17) ──────────────────────────────────────────────

const SQL_TITLE = /^query-(\d+)\.sql$/;

/**
 * Next free `query-N.sql` title. SQL tabs are numbered among themselves
 * (table / Redis / OpenSearch tabs don't consume numbers) and a number is
 * never reused while a tab with it is open, so titles can't collide.
 */
export function nextSqlTabTitle(tabs: readonly Pick<QueryTab, 'title' | 'kind'>[]): string {
  let max = 0;
  for (const t of tabs) {
    if (t.kind !== 'sql') continue;
    const m = SQL_TITLE.exec(t.title);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `query-${max + 1}.sql`;
}

/** Title for a copy of `title` that doesn't clash with any open tab. */
export function duplicateTitle(title: string, tabs: readonly Pick<QueryTab, 'title'>[]): string {
  const taken = new Set(tabs.map((t) => t.title));
  const m = /^(.*?)(\.sql)?$/.exec(title);
  const stem = m?.[1] ?? title;
  const ext = m?.[2] ?? '';
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// ─── Dirty / preview ─────────────────────────────────────────────────

/**
 * A SQL tab is dirty when its buffer differs from what was last loaded or
 * saved (`cleanSql`: '' for a new tab, the file / snippet text otherwise).
 * An emptied scratch tab is not dirty — there is nothing to lose.
 */
export function isTabDirty(tab: QueryTab): boolean {
  if (tab.kind !== 'sql') return false;
  const clean = typeof tab.cleanSql === 'string' ? tab.cleanSql : '';
  if (tab.sql === clean) return false;
  return tab.sql.trim().length > 0 || Boolean(tab.fileName);
}

/**
 * A preview tab (single-click table open, italic title) is replaced by
 * the next single click — but only while the user hasn't worked in it.
 * Paging, sorting, filtering, switching view, or queuing an edit pins it.
 */
export function isPreviewTab(tab: QueryTab, pendingEditTabIds?: ReadonlySet<string>): boolean {
  if (!tab.preview || tab.kind !== 'table') return false;
  if (pendingEditTabIds?.has(tab.id)) return false;
  return (
    tab.page === 0 &&
    tab.filters.length === 0 &&
    tab.tableSort.length === 0 &&
    tab.viewMode === 'data'
  );
}

// ─── Persistence (D1) ────────────────────────────────────────────────

export interface PersistedTab {
  kind: 'sql' | 'table';
  title: string;
  sql?: string;
  cleanSql?: string;
  fileName?: string;
  tableSchema?: string;
  tableName?: string;
  filters?: Filter[];
  tableSort?: TableSort[];
  viewMode?: TableViewMode;
  pageSize?: number;
}

export interface PersistedTabs {
  v: 1;
  activeIndex: number;
  tabs: PersistedTab[];
}

const STORAGE_PREFIX = 'plasma.tabs.v1.';
/** Keep one runaway buffer from filling localStorage. */
export const MAX_SQL_CHARS = 512 * 1024;

export function storageKey(connectionId: string): string {
  return `${STORAGE_PREFIX}${connectionId}`;
}

/** Postgres SQL + table tabs, in order, with the active tab's index. */
export function serializeTabs(tabs: readonly QueryTab[], activeTabId: string): PersistedTabs {
  const out: PersistedTab[] = [];
  let activeIndex = 0;
  for (const t of tabs) {
    if (t.kind === 'sql') {
      if (t.sql.length > MAX_SQL_CHARS) continue;
      if (t.id === activeTabId) activeIndex = out.length;
      out.push({
        kind: 'sql',
        title: t.title,
        sql: t.sql,
        ...(typeof t.cleanSql === 'string' && t.cleanSql !== '' ? { cleanSql: t.cleanSql } : {}),
        ...(t.fileName ? { fileName: t.fileName } : {}),
      });
    } else if (t.kind === 'table' && t.tableSchema && t.tableName) {
      if (t.id === activeTabId) activeIndex = out.length;
      out.push({
        kind: 'table',
        title: t.title,
        tableSchema: t.tableSchema,
        tableName: t.tableName,
        filters: t.filters,
        tableSort: t.tableSort,
        viewMode: t.viewMode,
        pageSize: t.pageSize,
      });
    }
  }
  return { v: 1, activeIndex, tabs: out };
}

/** Validate an untrusted persisted payload; null when unusable. */
export function parsePersistedTabs(raw: unknown): PersistedTabs | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<PersistedTabs>;
  if (r.v !== 1 || !Array.isArray(r.tabs)) return null;
  const tabs = r.tabs.filter((t): t is PersistedTab => {
    if (!t || typeof t !== 'object' || typeof t.title !== 'string') return false;
    if (t.kind === 'sql') return typeof t.sql === 'string';
    if (t.kind === 'table')
      return typeof t.tableSchema === 'string' && typeof t.tableName === 'string';
    return false;
  });
  if (tabs.length === 0) return null;
  const activeIndex =
    typeof r.activeIndex === 'number' && r.activeIndex >= 0 && r.activeIndex < tabs.length
      ? r.activeIndex
      : 0;
  return { v: 1, activeIndex, tabs };
}

/**
 * Rebuild live tabs from a persisted payload. `makeSql` / `makeTable`
 * are the store's tab factories so restored tabs get every default field.
 */
export function restoreTabs(
  persisted: PersistedTabs,
  makeSql: (title: string) => QueryTab,
  makeTable: (schema: string, table: string) => QueryTab,
): { tabs: QueryTab[]; activeTabId: string } {
  const tabs: QueryTab[] = persisted.tabs.map((p) => {
    if (p.kind === 'sql') {
      return {
        ...makeSql(p.title),
        sql: p.sql ?? '',
        cleanSql: p.cleanSql ?? '',
        ...(p.fileName ? { fileName: p.fileName } : {}),
      };
    }
    const base = makeTable(p.tableSchema!, p.tableName!);
    return {
      ...base,
      title: p.title || base.title,
      filters: Array.isArray(p.filters) ? p.filters.map((f) => ({ ...f })) : [],
      tableSort: Array.isArray(p.tableSort) ? p.tableSort.map((s) => ({ ...s })) : [],
      viewMode: p.viewMode ?? 'data',
      pageSize: typeof p.pageSize === 'number' && p.pageSize > 0 ? p.pageSize : base.pageSize,
    };
  });
  return { tabs, activeTabId: tabs[persisted.activeIndex]?.id ?? tabs[0]!.id };
}

export function loadPersistedTabs(connectionId: string): PersistedTabs | null {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey(connectionId));
    return raw ? parsePersistedTabs(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function savePersistedTabs(connectionId: string, data: PersistedTabs): void {
  try {
    if (data.tabs.length === 0) globalThis.localStorage?.removeItem(storageKey(connectionId));
    else globalThis.localStorage?.setItem(storageKey(connectionId), JSON.stringify(data));
  } catch (err) {
    console.error('[plasma] persist tabs failed', err);
  }
}

// ─── Store subscription ──────────────────────────────────────────────

interface PersistableState {
  tabs: QueryTab[];
  activeTabId: string;
  tabsConnectionId?: string | null;
  activeConfig: { id?: string; engine?: string } | null;
}

interface SubscribableStore<S> {
  getState(): S;
  subscribe(listener: (state: S, prev: S) => void): () => void;
}

const PERSIST_DEBOUNCE_MS = 600;

/**
 * Write tabs to localStorage (debounced) whenever they change, keyed by
 * the connection the tabs were adopted for. Tabs only persist once
 * `tabsConnectionId` matches the live connection, so a reset during a
 * connection switch can never overwrite the next connection's saved tabs.
 */
export function installTabPersistence<S extends PersistableState>(
  store: SubscribableStore<S>,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { connectionId: string; data: () => PersistedTabs } | null = null;

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const p = pending;
    pending = null;
    if (p) savePersistedTabs(p.connectionId, p.data());
  };

  const unsub = store.subscribe((state, prev) => {
    if (state.tabs === prev.tabs && state.activeTabId === prev.activeTabId) return;
    const connId = state.activeConfig?.id;
    const engine = state.activeConfig?.engine ?? 'postgres';
    if (!connId || engine !== 'postgres' || state.tabsConnectionId !== connId) return;
    if (pending && pending.connectionId !== connId) flush();
    const { tabs, activeTabId } = state;
    pending = { connectionId: connId, data: () => serializeTabs(tabs, activeTabId) };
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, PERSIST_DEBOUNCE_MS);
  });

  const onUnload = () => flush();
  globalThis.addEventListener?.('beforeunload', onUnload);
  return () => {
    flush();
    unsub();
    globalThis.removeEventListener?.('beforeunload', onUnload);
  };
}

// ─── Slice ───────────────────────────────────────────────────────────

export interface TabsSlice {
  tabs: QueryTab[];
  activeTabId: string;
  /** Open (or focus) an ER diagram tab for a schema or a set of `schema.table` ids. */
  openErDiagram(scope: { schema?: string; tables?: string[] }): void;
  // Tab management
  addTab(): void;
  closeTab(id: string): void;
  setActiveTab(id: string): void;
  renameActiveTab(title: string): void;
  setTabViewMode(mode: TableViewMode): void;
  /** Close tabs, asking first (via `closeTabsRequest`) when any has unsaved SQL. */
  requestCloseTabs(ids: string[]): void;
  confirmCloseTabs(): void;
  cancelCloseTabs(): void;
  closeOtherTabs(id: string): void;
  closeTabsToRight(id: string): void;
  closeAllTabs(): void;
  duplicateTab(id: string): void;
  renameTab(id: string, title: string): void;
  /** Turn a preview tab into a permanent one. */
  pinTab(id: string): void;
  moveTab(id: string, toIndex: number): void;
  /** New SQL tab holding `sql` (history, snippets, files, DDL) — never clobbers. */
  openSqlInNewTab(
    sql: string,
    opts?: { title?: string; fileName?: string; clean?: boolean },
  ): string;
  /** Mark a SQL tab's buffer as saved (file / snippet). */
  markTabClean(id: string, patch?: { title?: string; fileName?: string }): void;
  /** Close tabs immediately, no dirty check. */
  closeTabsNow(ids: string[]): void;
  /** Pending "close tabs with unsaved SQL?" confirmation (D1). */
  closeTabsRequest: { ids: string[]; dirtyTitles: string[]; editCount?: number } | null;
  tabsConnectionId: string | null;
}

const initialTab = createEmptyTab(DEFAULT_SETTINGS.defaultPageSize);

export const createTabsSlice: SliceCreator<TabsSlice> = (set, get) => ({
  tabs: [initialTab],
  tabsConnectionId: null,
  closeTabsRequest: null,
  activeTabId: initialTab.id,

  openErDiagram(scope) {
    const state = get();
    const key = scope.tables?.length
      ? [...scope.tables].sort().join(',')
      : (scope.schema ?? 'public');
    const existing = state.tabs.find((t) => t.kind === 'er-diagram' && t.erScopeKey === key);
    if (existing) {
      get().setActiveTab(existing.id);
      return;
    }
    const title = scope.tables?.length
      ? `Diagram · ${scope.tables.length} tables`
      : `Diagram · ${scope.schema ?? 'public'}`;
    const tab: QueryTab = {
      ...createEmptyTab(state.settings.defaultPageSize, title),
      kind: 'er-diagram',
      erScope: { schema: scope.schema, tables: scope.tables },
      erScopeKey: key,
    };
    set({ tabs: [...state.tabs, tab], activeTabId: tab.id });
  },

  // ── tabs ──

  addTab() {
    const state = get();
    const pageSize = state.settings.defaultPageSize;
    // SQL tabs are numbered among themselves, never reusing an open number (D3).
    const tab = createEmptyTab(pageSize, nextSqlTabTitle(state.tabs));
    set({ tabs: [...state.tabs, tab], activeTabId: tab.id, canvasMode: 'database' });
    useWorkbench.getState().showEditor();
  },

  /** Close without asking (UI goes through `requestCloseTabs`). */
  closeTab(id) {
    get().closeTabsNow([id]);
  },

  closeTabsNow(ids: string[]) {
    const state = get();
    const drop = new Set(ids.filter((id) => state.tabs.some((t) => t.id === id)));
    if (drop.size === 0) return;
    // A closed tab's in-flight user query is cancelled; its result would be
    // dropped by the origin-tab guard anyway (U03).
    if (
      state.tabs.some((t) => drop.has(t.id) && t.kind === 'sql' && t.queryRunState === 'running')
    ) {
      try {
        void ipc.query.cancel().catch(() => undefined);
      } catch {
        /* preload unavailable (tests) */
      }
    }
    const remaining = state.tabs.filter((t) => !drop.has(t.id));
    if (remaining.length === 0) {
      // Never leave the strip empty — a fresh scratch tab takes over.
      const fresh = createEmptyTab(state.settings.defaultPageSize);
      set({
        tabs: [fresh],
        activeTabId: fresh.id,
        closeTabsRequest: null,
        pendingEditsByTab: withoutTabEdits(state.pendingEditsByTab, drop),
      });
      return;
    }
    let nextActive = state.activeTabId;
    if (drop.has(state.activeTabId)) {
      // Activate the nearest surviving tab to the right, else the left.
      const idx = state.tabs.findIndex((t) => t.id === state.activeTabId);
      const after = state.tabs.slice(idx + 1).find((t) => !drop.has(t.id));
      const before = [...state.tabs.slice(0, idx)].reverse().find((t) => !drop.has(t.id));
      nextActive = (after ?? before ?? remaining[0]!).id;
    }
    // R-02: a closed tab's staged edits go with it — they can no longer be
    // seen, so they must never be committed later by another tab's Commit.
    set({
      tabs: remaining,
      activeTabId: nextActive,
      pendingEditsByTab: withoutTabEdits(state.pendingEditsByTab, drop),
    });
  },

  requestCloseTabs(ids) {
    const state = get();
    // Unsaved SQL, or staged grid edits that closing would discard (R-02).
    const dirty = state.tabs.filter(
      (t) =>
        ids.includes(t.id) && (isTabDirty(t) || editsOf(state.pendingEditsByTab, t.id).length > 0),
    );
    if (dirty.length === 0) {
      get().closeTabsNow(ids);
      return;
    }
    const editCount = pendingEditCount(
      Object.fromEntries(
        ids
          .map((id) => [id, editsOf(state.pendingEditsByTab, id)] as const)
          .filter(([, l]) => l.length),
      ),
    );
    set({
      closeTabsRequest: {
        ids,
        dirtyTitles: dirty.map((t) => t.title),
        ...(editCount > 0 ? { editCount } : {}),
      },
    });
  },

  confirmCloseTabs() {
    const req = get().closeTabsRequest;
    set({ closeTabsRequest: null });
    if (req) get().closeTabsNow(req.ids);
  },

  cancelCloseTabs() {
    set({ closeTabsRequest: null });
  },

  closeOtherTabs(id) {
    get().requestCloseTabs(
      get()
        .tabs.filter((t) => t.id !== id)
        .map((t) => t.id),
    );
  },

  closeTabsToRight(id) {
    const tabs = get().tabs;
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    get().requestCloseTabs(tabs.slice(idx + 1).map((t) => t.id));
  },

  closeAllTabs() {
    get().requestCloseTabs(get().tabs.map((t) => t.id));
  },

  duplicateTab(id) {
    const state = get();
    const src = state.tabs.find((t) => t.id === id);
    if (!src) return;
    let copy: QueryTab;
    if (src.kind === 'sql') {
      copy = {
        ...createEmptyTab(src.pageSize, duplicateTitle(src.title, state.tabs)),
        sql: src.sql,
      };
    } else if (src.kind === 'table' && src.tableSchema && src.tableName) {
      copy = {
        ...createTableTab(src.pageSize, src.tableSchema, src.tableName),
        title: duplicateTitle(src.title, state.tabs),
        filters: src.filters.map((f) => ({ ...f })),
        tableSort: src.tableSort.map((x) => ({ ...x })),
        hiddenColumns: new Set(src.hiddenColumns),
        stickyColumns: new Set(src.stickyColumns),
        columnWidths: { ...src.columnWidths },
        viewMode: src.viewMode,
        page: src.page,
      };
    } else {
      return; // Redis / OpenSearch tabs are opened from their sidebars
    }
    const idx = state.tabs.findIndex((t) => t.id === id);
    const tabs = [...state.tabs.slice(0, idx + 1), copy, ...state.tabs.slice(idx + 1)];
    set({ tabs, activeTabId: copy.id });
    if (copy.kind === 'table') {
      loadTableTab(set, get, copy.id);
    }
  },

  renameTab(id, title) {
    const trimmed = title.trim();
    if (!trimmed) return;
    patchTabById(set, id, { title: trimmed, preview: false });
  },

  pinTab(id) {
    const tab = get().tabs.find((t) => t.id === id);
    if (tab?.preview) patchTabById(set, id, { preview: false });
  },

  moveTab(id, toIndex) {
    const tabs = [...get().tabs];
    const from = tabs.findIndex((t) => t.id === id);
    if (from === -1) return;
    const [tab] = tabs.splice(from, 1);
    tabs.splice(Math.max(0, Math.min(toIndex, tabs.length)), 0, tab!);
    set({ tabs });
  },

  openSqlInNewTab(sql, opts) {
    const state = get();
    const tab: QueryTab = {
      ...createEmptyTab(state.settings.defaultPageSize, opts?.title ?? nextSqlTabTitle(state.tabs)),
      sql,
      cleanSql: opts?.clean ? sql : '',
      ...(opts?.fileName ? { fileName: opts.fileName } : {}),
    };
    set({
      tabs: [...state.tabs, tab],
      activeTabId: tab.id,
      canvasMode: 'database',
      historyOpen: false,
    });
    useWorkbench.getState().showEditor();
    return tab.id;
  },

  markTabClean(id, patch) {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return;
    patchTabById(set, id, {
      cleanSql: tab.sql,
      ...(patch?.title ? { title: patch.title } : {}),
      ...(patch?.fileName ? { fileName: patch.fileName } : {}),
    });
  },

  setActiveTab(id) {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return;
    set({ activeTabId: id });
    // Restored table tabs (D1) load lazily the first time they're shown.
    if (
      tab.kind === 'table' &&
      !tab.queryResult &&
      !tab.queryError &&
      tab.queryRunState !== 'running' &&
      get().connectionState === 'connected'
    ) {
      if (tab.tableSchema) void get().ensureSchemaColumns?.(tab.tableSchema);
      loadTableTab(set, get, id);
    }
  },

  renameActiveTab(title) {
    get().renameTab(get().activeTabId, title);
  },

  setTabViewMode(mode) {
    patchActiveTab(set, get, { viewMode: mode });
  },
});

/**
 * After a connection is established, make the tab strip belong to it
 * (D1): restore that connection's saved tabs, or — when the open tabs
 * belong to a different connection — start from one fresh tab. Reconnects
 * to the same connection keep the live tabs, which are newer.
 */
export function adoptConnectionTabs(
  set: (patch: Partial<SessionState>) => void,
  get: () => SessionState,
  engine: ConnectionEngine,
): void {
  const state = get();
  const connId = state.activeConfig?.id ?? null;
  if (connId && state.tabsConnectionId === connId) {
    // R-07: same connection, new session. The live tabs stay, but their
    // results were cleared — reload the one on screen (others reload when
    // they are selected).
    if (state.tabs.some((t) => t.id === state.activeTabId && t.kind === 'table')) {
      get().setActiveTab(state.activeTabId);
    }
    return;
  }
  const pageSize = state.settings.defaultPageSize;
  // Settings → "Restore tabs on launch" (restoreWorkspace, default on).
  const restore = state.settings.restoreWorkspace !== false;
  const persisted = restore && connId && engine === 'postgres' ? loadPersistedTabs(connId) : null;
  const pristine =
    state.tabs.length === 1 &&
    state.tabs[0]!.kind === 'sql' &&
    state.tabs[0]!.sql.trim() === '' &&
    !state.tabs[0]!.queryResult;
  if (persisted) {
    const { tabs, activeTabId } = restoreTabs(
      persisted,
      (title) => createEmptyTab(pageSize, title),
      (schemaName, tableName) => createTableTab(pageSize, schemaName, tableName),
    );
    set({ tabs, activeTabId, tabsConnectionId: connId });
    get().setActiveTab(activeTabId);
    return;
  }
  if (state.tabsConnectionId !== null && !pristine) {
    const fresh = createEmptyTab(pageSize);
    set({ tabs: [fresh], activeTabId: fresh.id, tabsConnectionId: connId });
    return;
  }
  set({ tabsConnectionId: connId });
}
