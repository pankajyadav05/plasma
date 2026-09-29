import type { Filter, TableSort } from '@/lib/table-query';
import type { QueryTab, TableViewMode } from './session';

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
const MAX_SQL_CHARS = 512 * 1024;

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
