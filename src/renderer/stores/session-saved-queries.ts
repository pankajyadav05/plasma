/**
 * Saved-query list helpers (PC6): build an entry from a tab, update an
 * entry in place, and patch name / folder / favourite. Pure so the
 * session actions stay thin and the rules are unit-testable.
 */
import { ipc } from '@/lib/ipc';
import { listVariables, pruneVariableValues } from '@/lib/query-variables';
import type { SavedQuery } from '@shared/protocol';
import type { VariableValue } from '@shared/sql-variables';
import {
  activeTab,
  createEmptyTab,
  createTableTab,
  freshId,
  loadTableColumnStateInto,
} from './session-tab-model';
import { loadTableTab } from './session-table-query';
import type { QueryTab, SessionState, SliceCreator } from './session-types';
import { useWorkbench } from './workbench';

type SetSession = (partial: Partial<SessionState>) => void;

/** The tab fields a saved query snapshots. */
export interface SavableTab {
  kind: string;
  sql: string;
  pageSize: number;
  tableSchema?: string;
  tableName?: string;
  filters: Array<{ id: string; column: string; op: string; value: string }>;
  tableSort: Array<{ column: string; direction: 'asc' | 'desc' }>;
  hiddenColumns: Set<string>;
  stickyColumns: Set<string>;
  /** Query variable values (`:name`, `$name`) of a SQL tab. */
  queryVars?: Record<string, VariableValue>;
}

/** Snapshot `tab` as a saved query. Keeps id / createdAt / folder / favourite of `base`. */
export function savedQueryFromTab(
  tab: SavableTab,
  meta: { id: string; name: string; now: number },
  base?: SavedQuery,
): SavedQuery {
  const common = {
    id: meta.id,
    name: meta.name,
    createdAt: base?.createdAt ?? meta.now,
    updatedAt: meta.now,
    ...(base?.folder ? { folder: base.folder } : {}),
    ...(base?.favorite ? { favorite: true } : {}),
  };
  if (tab.kind === 'table' && tab.tableSchema && tab.tableName) {
    return {
      ...common,
      kind: 'table',
      tableSchema: tab.tableSchema,
      tableName: tab.tableName,
      filters: tab.filters.map((f) => ({ ...f })) as Extract<
        SavedQuery,
        { kind: 'table' }
      >['filters'],
      sort: tab.tableSort.map((s) => ({ ...s })) as Extract<SavedQuery, { kind: 'table' }>['sort'],
      hidden: [...tab.hiddenColumns],
      sticky: [...tab.stickyColumns],
      pageSize: tab.pageSize,
    };
  }
  // Variable values are kept for the placeholders the SQL still uses.
  const variables = pruneVariableValues(tab.queryVars ?? {}, listVariables(tab.sql));
  return {
    ...common,
    kind: 'sql',
    sql: tab.sql,
    ...(Object.keys(variables).length > 0 ? { variables } : {}),
    pageSize: tab.pageSize,
  };
}

export type SavedQueryPatch = { name?: string; folder?: string | null; favorite?: boolean };

/** Apply a rename / move / favourite patch. Returns the same list when nothing changed. */
export function patchSavedQuery(
  list: SavedQuery[],
  id: string,
  patch: SavedQueryPatch,
  now: number,
): SavedQuery[] {
  let changed = false;
  const next = list.map((q) => {
    if (q.id !== id) return q;
    let out: SavedQuery = { ...q };
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (name && name !== q.name) {
        out.name = name;
        changed = true;
      }
    }
    if (patch.folder !== undefined) {
      const folder = patch.folder?.trim() || undefined;
      if (folder !== q.folder) {
        if (folder) out.folder = folder;
        else {
          const { folder: _drop, ...rest } = out;
          out = rest as SavedQuery;
        }
        changed = true;
      }
    }
    if (patch.favorite !== undefined && Boolean(q.favorite) !== patch.favorite) {
      if (patch.favorite) out.favorite = true;
      else {
        const { favorite: _drop, ...rest } = out;
        out = rest as SavedQuery;
      }
      changed = true;
    }
    if (changed) out.updatedAt = now;
    return out;
  });
  return changed ? next : list;
}

/** Replace entry `id` with `entry` (update in place), keeping its position. */
export function replaceSavedQuery(list: SavedQuery[], entry: SavedQuery): SavedQuery[] {
  const idx = list.findIndex((q) => q.id === entry.id);
  if (idx === -1) return [entry, ...list];
  const next = list.slice();
  next[idx] = entry;
  return next;
}

/** Folder names in use, sorted. */
export function savedQueryFolders(list: SavedQuery[]): string[] {
  return [...new Set(list.map((q) => q.folder).filter((f): f is string => Boolean(f)))].sort(
    (a, b) => a.localeCompare(b),
  );
}

// ─── Slice ───────────────────────────────────────────────────────────

export interface SavedQueriesSlice {
  saveCurrentTab(name: string): Promise<void>;
  deleteSavedQuery(id: string): Promise<void>;
  openSavedQuery(id: string): void;
  /** Rename / move to folder / (un)favourite a saved query. */
  updateSavedQuery(id: string, patch: SavedQueryPatch): Promise<void>;
  /** Overwrite saved query `id` with the active tab's current contents. */
  updateSavedQueryFromTab(id: string): Promise<void>;
  /** Save arbitrary SQL (e.g. a history entry) as a saved query. */
  saveSqlAsQuery(name: string, sql: string): Promise<void>;
}

type SavedQueriesMap = Record<string, SavedQuery[]>;

/** Persist the whole map; a failed write is logged and the in-memory copy stays. */
async function persistSavedQueries(savedQueries: SavedQueriesMap): Promise<void> {
  try {
    await ipc.settings.set({ savedQueries });
  } catch (err) {
    console.error('[plasma] persist savedQueries failed', err);
  }
}

/**
 * Prepend a plain SQL snippet to `connectionId`'s saved queries (defaults to
 * the active connection). Shared by "Save as query" and history "Save as snippet".
 */
export async function addSqlSnippet(
  set: SetSession,
  get: () => SessionState,
  name: string,
  sql: string,
  connectionId?: string | null,
): Promise<void> {
  const state = get();
  const connId = connectionId || state.activeConfig?.id;
  const trimmed = name.trim();
  if (!connId || !trimmed || !sql.trim()) return;
  const now = Date.now();
  const entry: SavedQuery = {
    kind: 'sql',
    id: freshId(),
    name: trimmed,
    createdAt: now,
    updatedAt: now,
    sql,
    pageSize: state.settings.defaultPageSize,
  };
  const current = state.settings.savedQueries ?? {};
  const nextMap = { ...current, [connId]: [entry, ...(current[connId] ?? [])] };
  set({ settings: { ...state.settings, savedQueries: nextMap } });
  await persistSavedQueries(nextMap);
}

export const createSavedQueriesSlice: SliceCreator<SavedQueriesSlice> = (set, get) => ({
  async saveCurrentTab(name) {
    const state = get();
    const tab = activeTab(state);
    const connId = state.activeConfig?.id;
    if (!tab || !connId) return;
    const trimmed = name.trim();
    if (!trimmed) return;

    const entry = savedQueryFromTab(tab, { id: freshId(), name: trimmed, now: Date.now() });
    const current = state.settings.savedQueries ?? {};
    const list = current[connId] ?? [];
    const nextMap = { ...current, [connId]: [entry, ...list] };
    set({
      settings: { ...state.settings, savedQueries: nextMap },
      // Later "Update" writes back to this entry instead of duplicating it (PC6).
      tabs: get().tabs.map((t) =>
        t.id === tab.id ? { ...t, savedQueryId: entry.id, cleanSql: t.sql } : t,
      ),
    });
    await persistSavedQueries(nextMap);
  },

  async updateSavedQueryFromTab(id) {
    const state = get();
    const tab = activeTab(state);
    const connId = state.activeConfig?.id;
    if (!tab || !connId) return;
    const current = state.settings.savedQueries ?? {};
    const list = current[connId] ?? [];
    const base = list.find((q) => q.id === id);
    if (!base) return;
    const entry = savedQueryFromTab(tab, { id, name: base.name, now: Date.now() }, base);
    const nextMap = { ...current, [connId]: replaceSavedQuery(list, entry) };
    set({
      settings: { ...state.settings, savedQueries: nextMap },
      tabs: get().tabs.map((t) =>
        t.id === tab.id ? { ...t, savedQueryId: id, cleanSql: t.sql } : t,
      ),
    });
    await persistSavedQueries(nextMap);
  },

  async updateSavedQuery(id, patch) {
    const state = get();
    const connId = state.activeConfig?.id;
    if (!connId) return;
    const current = state.settings.savedQueries ?? {};
    const list = current[connId] ?? [];
    const nextList = patchSavedQuery(list, id, patch, Date.now());
    if (nextList === list) return;
    const nextMap = { ...current, [connId]: nextList };
    set({ settings: { ...state.settings, savedQueries: nextMap } });
    await persistSavedQueries(nextMap);
  },

  async saveSqlAsQuery(name, sql) {
    await addSqlSnippet(set, get, name, sql);
  },

  async deleteSavedQuery(id) {
    const state = get();
    const connId = state.activeConfig?.id;
    if (!connId) return;
    const current = state.settings.savedQueries ?? {};
    const list = current[connId] ?? [];
    const nextList = list.filter((q) => q.id !== id);
    if (nextList.length === list.length) return;
    const nextMap = { ...current, [connId]: nextList };
    set({ settings: { ...state.settings, savedQueries: nextMap } });
    await persistSavedQueries(nextMap);
  },

  openSavedQuery(id) {
    const state = get();
    const connId = state.activeConfig?.id;
    if (!connId) return;
    const entry = (state.settings.savedQueries?.[connId] ?? []).find((q) => q.id === id);
    if (!entry) return;

    if (entry.kind === 'sql') {
      // Spawn a fresh SQL tab pre-loaded with the saved text. Avoids
      // clobbering whatever the user has in their current tab.
      const tab = createEmptyTab(entry.pageSize, entry.name);
      tab.sql = entry.sql;
      tab.cleanSql = entry.sql;
      tab.savedQueryId = entry.id;
      // Saved variable values come back as defaults; the first run still
      // shows the Variables bar so they are confirmed, not silently reused.
      if (entry.variables) tab.queryVars = { ...entry.variables };
      // E1: open in the editor without closing the right sidebar.
      set({
        tabs: [...state.tabs, tab],
        activeTabId: tab.id,
        canvasMode: 'database',
      });
      useWorkbench.getState().showEditor();
      return;
    }

    // Table snapshot: build a fresh table tab with the saved
    // filters/sort/hidden/sticky pre-applied, then run.
    void get().ensureSchemaColumns(entry.tableSchema);
    const baseTab = createTableTab(entry.pageSize, entry.tableSchema, entry.tableName);
    const persistedPatch = loadTableColumnStateInto(state, entry.tableSchema, entry.tableName);
    const tab: QueryTab = {
      ...baseTab,
      ...persistedPatch,
      filters: entry.filters.map((f) => ({ ...f })),
      tableSort: entry.sort.map((s) => ({ ...s })),
      hiddenColumns: new Set(entry.hidden),
      stickyColumns: new Set(entry.sticky),
      pageSize: entry.pageSize,
      savedQueryId: entry.id,
    };
    set({
      tabs: [...state.tabs, tab],
      activeTabId: tab.id,
      activeTable: { schema: entry.tableSchema, name: entry.tableName },
    });
    loadTableTab(set, get, tab.id, true);
  },
});
