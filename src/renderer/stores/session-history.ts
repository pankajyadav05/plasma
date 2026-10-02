/** Query-history slice: the cached list, its server-side filters and recall. */
import { ipc } from '@/lib/ipc';
import type { HistoryEntry, HistoryListOpts } from '@shared/protocol';
import { addSqlSnippet } from './session-saved-queries';
import { activeTab, patchActiveTab } from './session-tab-model';
import type { SliceCreator } from './session-types';
import { useWorkbench } from './workbench';

export interface HistorySlice {
  // ── query history (cached copy for the history sheet / canvas) ──
  history: HistoryEntry[];
  /** Active server-side filters for history.list (U35). */
  historyFilter: HistoryListOpts;
  loadHistory(opts?: HistoryListOpts): Promise<void>;
  setHistoryFilter(patch: Partial<HistoryListOpts>): void;
  clearHistory(): Promise<void>;
  /** Remove one history entry (store + local db). */
  deleteHistoryEntry(id: number): Promise<void>;
  reuseHistoryQuery(sql: string): void;
  /** Pin a history SQL string into saved queries (snippet). */
  saveHistoryAsSnippet(sql: string, name: string, connectionId?: string | null): Promise<void>;
  /** ⌘↑ in an empty editor — recall the previous statement for this connection. */
  recallPreviousHistory(): Promise<boolean>;
}

/** Monotonic id of the latest `loadHistory` call. */
let historyRequestSeq = 0;

export const createHistorySlice: SliceCreator<HistorySlice> = (set, get) => ({
  history: [],
  historyFilter: { status: 'all', duration: 'all' },

  async loadHistory(opts) {
    const state = get();
    const merged: HistoryListOpts = {
      ...state.historyFilter,
      ...(opts ?? {}),
      limit: opts?.limit ?? state.historyFilter.limit ?? 500,
    };
    // Persist filter patch (search/facets) before the round-trip.
    if (opts && Object.keys(opts).length > 0) {
      set({ historyFilter: { ...state.historyFilter, ...opts } });
    }

    // connectionId semantics:
    //   - omitted / undefined → default to the active connection
    //   - '' → all connections (no SQL filter)
    //   - concrete id → that connection only
    let connectionId = merged.connectionId;
    if (connectionId === undefined) {
      connectionId = state.activeConfig?.id;
    } else if (connectionId === '') {
      connectionId = undefined;
    }

    const status = merged.status === 'all' ? undefined : merged.status;
    const duration = merged.duration === 'all' ? undefined : merged.duration;
    const search = merged.search?.trim() ? merged.search : undefined;

    // R-29: only the newest request may publish; a slow older search must
    // not overwrite the results of the one the user typed after it.
    const seq = ++historyRequestSeq;
    try {
      const history = await ipc.history.list({
        limit: merged.limit,
        connectionId,
        search,
        status,
        duration,
      });
      if (seq !== historyRequestSeq) return;
      set({ history });
    } catch (err) {
      console.error('[plasma] history.list failed', err);
    }
  },

  setHistoryFilter(patch) {
    set({ historyFilter: { ...get().historyFilter, ...patch } });
  },

  async clearHistory() {
    await ipc.history.clear();
    set({ history: [] });
  },

  async deleteHistoryEntry(id) {
    await ipc.history.delete(id);
    set({ history: get().history.filter((h) => h.id !== id) });
  },

  reuseHistoryQuery(sql) {
    // E1: history always opens in a new SQL tab on the database canvas —
    // it never overwrites the active tab or closes the right sidebar.
    get().openSqlInNewTab(sql);
  },

  async saveHistoryAsSnippet(sql, name, connectionId) {
    await addSqlSnippet(set, get, name, sql, connectionId);
  },

  async recallPreviousHistory() {
    const state = get();
    const tab = activeTab(state);
    if (!tab || tab.kind !== 'sql') return false;
    if (tab.sql.trim().length > 0) return false;
    try {
      const entry = await ipc.history.latest({
        connectionId: state.activeConfig?.id,
      });
      if (!entry?.sql) return false;
      patchActiveTab(set, get, { sql: entry.sql });
      set({ canvasMode: 'database' });
      useWorkbench.getState().showEditor();
      return true;
    } catch (err) {
      console.error('[plasma] recallPreviousHistory failed', err);
      return false;
    }
  },
});
