/** OpenSearch slice: cluster overview, index tabs and the New / Delete index dialogs. */
import { ipc } from '@/lib/ipc';
import type { OsOverview } from '@shared/protocol';
import { createEmptyTab } from './session-tab-model';
import type { QueryTab, SliceCreator } from './session-types';

export interface OpenSearchSlice {
  /** Latest cluster + indices snapshot for a connected OpenSearch cluster. */
  osOverview: OsOverview | null;
  osLoading: boolean;
  /** True while the New Index dialog is mounted. */
  osNewIndexOpen: boolean;
  /** Index name pending delete-confirmation, or null when closed. */
  osDeleteIndexName: string | null;
  activeOsIndex: string | null;
  refreshOsOverview(): Promise<void>;
  openOsIndex(index: string): void;
  openOsSearch(index: string): void;
  openOsSql(): void;
  /** Open (or focus) the OpenSearch Dev Tools console tab (O14). */
  openOsConsole(): void;
  openOsNewIndex(): void;
  closeOsNewIndex(): void;
  /** Open the type-to-confirm delete dialog for `name`, or close it with null. */
  requestOsDeleteIndex(name: string | null): void;
}

export const createOpenSearchSlice: SliceCreator<OpenSearchSlice> = (set, get) => ({
  osOverview: null,
  osLoading: false,
  osNewIndexOpen: false,
  osDeleteIndexName: null,
  activeOsIndex: null,

  async refreshOsOverview() {
    set({ osLoading: true });
    try {
      const info = await ipc.os.overview();
      set({ osOverview: info });
    } catch (err) {
      console.error('[plasma] os overview failed', err);
    } finally {
      set({ osLoading: false });
    }
  },

  openOsIndex(index) {
    const state = get();
    const existing = state.tabs.find((t) => t.kind === 'os-index' && t.osIndex === index);
    if (existing) {
      set({ activeTabId: existing.id, activeOsIndex: index });
      return;
    }
    const tab: QueryTab = {
      ...createEmptyTab(state.settings.defaultPageSize, index),
      kind: 'os-index',
      osIndex: index,
    };
    set({
      tabs: [...state.tabs, tab],
      activeTabId: tab.id,
      activeOsIndex: index,
    });
  },

  openOsSearch(index) {
    const state = get();
    // Always make a new search tab — the user might want multiple
    // queries against the same index running side by side.
    const tab: QueryTab = {
      ...createEmptyTab(state.settings.defaultPageSize, `${index} · search`),
      kind: 'os-search',
      osIndex: index,
      osBody: '{\n  "query": { "match_all": {} },\n  "size": 50\n}',
      osQueryString: '',
    };
    set({
      tabs: [...state.tabs, tab],
      activeTabId: tab.id,
      activeOsIndex: index,
    });
  },

  openOsNewIndex() {
    set({ osNewIndexOpen: true });
  },

  closeOsNewIndex() {
    set({ osNewIndexOpen: false });
  },

  requestOsDeleteIndex(name) {
    set({ osDeleteIndexName: name });
  },

  openOsSql() {
    const state = get();
    const existing = state.tabs.find((t) => t.kind === 'os-sql');
    if (existing) {
      set({ activeTabId: existing.id });
      return;
    }
    // O20: start from a runnable query against a real index.
    const target =
      state.activeOsIndex ??
      state.osOverview?.indices.find((i) => !i.index.startsWith('.'))?.index ??
      null;
    const tab: QueryTab = {
      ...createEmptyTab(state.settings.defaultPageSize, 'sql'),
      kind: 'os-sql',
      osSql: target
        ? `SELECT * FROM ${/^[A-Za-z0-9_]+$/.test(target) ? target : `\`${target}\``} LIMIT 50`
        : 'SHOW TABLES LIKE %',
    };
    set({ tabs: [...state.tabs, tab], activeTabId: tab.id });
  },

  openOsConsole() {
    const state = get();
    const existing = state.tabs.find((t) => t.kind === 'os-console');
    if (existing) {
      set({ activeTabId: existing.id });
      return;
    }
    const tab: QueryTab = {
      ...createEmptyTab(state.settings.defaultPageSize, 'console'),
      kind: 'os-console',
    };
    set({ tabs: [...state.tabs, tab], activeTabId: tab.id });
  },
});
