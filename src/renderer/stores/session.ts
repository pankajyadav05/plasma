import { create } from 'zustand';
import type {
  ConnectionConfig,
  HistoryEntry,
  QueryResult,
  SavedConnection,
  SchemaInfo,
  Settings,
  TxnState,
} from '@shared/protocol';
import { ipc } from '@/lib/ipc';
import { buildCountSql, buildDataSql, type Filter, type TableSort } from '@/lib/table-query';

/**
 * Session store — the single source of truth for all renderer state.
 *
 * Design choices:
 *   - Multi-tab: the store holds an array of `tabs`, each with its own
 *     SQL, result, pagination, sort, and selection. `activeTabId` picks
 *     the one the editor + grid render.
 *   - Per-tab grid state (sort, selected cell, column widths) so switching
 *     tabs doesn't lose scroll/selection context.
 *   - Settings mirrored into the store from the main-process SQLite store
 *     on boot, and persisted via `updateSettings`.
 *   - Flat action surface — no slices yet, since every piece touches
 *     every other piece. Split if this file crosses ~500 lines.
 */

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error';
export type QueryRunState = 'idle' | 'running';
export type TabKind = 'sql' | 'table';

export interface QueryTab {
  id: string;
  title: string;
  kind: TabKind;

  /**
   * For SQL tabs this is the user-edited query. For table tabs it's
   * the last compiled query (read-only display so users can see what's
   * running under the hood).
   */
  sql: string;

  // ── Common query state ──
  queryRunState: QueryRunState;
  queryResult: QueryResult | null;
  queryError: string | null;
  page: number;
  pageSize: number;
  selectedCell: { row: number; col: number } | null;
  columnWidths: Record<number, number>;

  // ── SQL tab fields (client-side sort) ──
  sortColumn: { index: number; direction: 'asc' | 'desc' } | null;

  // ── Table tab fields (server-side sort/filter/hide) ──
  tableSchema?: string;
  tableName?: string;
  tableSort: TableSort[];
  filters: Filter[];
  hiddenColumns: Set<string>;
  totalRowCount: number | null;
  countLoading: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  theme: 'paper',
  sidebarCollapsed: false,
  sidebarWidth: 264,
  editorExpanded: false,
  editorFontSize: 14,
  defaultPageSize: 50,
  queryTimeoutMs: 0,
  telemetryEnabled: false,
  claudeApiKey: '',
  transactionMode: false,
  favoriteSchemas: {},
  favoriteTables: {},
  windowBounds: null,
};

function freshId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createEmptyTab(pageSize: number, title = 'query-1.sql'): QueryTab {
  return {
    id: freshId(),
    title,
    kind: 'sql',
    sql: '',
    queryRunState: 'idle',
    queryResult: null,
    queryError: null,
    page: 0,
    pageSize,
    sortColumn: null,
    selectedCell: null,
    columnWidths: {},
    tableSort: [],
    filters: [],
    hiddenColumns: new Set(),
    totalRowCount: null,
    countLoading: false,
  };
}

function createTableTab(
  pageSize: number,
  schemaName: string,
  tableName: string,
): QueryTab {
  const title = schemaName === 'public' ? tableName : `${schemaName}.${tableName}`;
  return {
    id: freshId(),
    title,
    kind: 'table',
    sql: '',
    queryRunState: 'idle',
    queryResult: null,
    queryError: null,
    page: 0,
    pageSize,
    sortColumn: null,
    selectedCell: null,
    columnWidths: {},
    tableSchema: schemaName,
    tableName,
    tableSort: [],
    filters: [],
    hiddenColumns: new Set(),
    totalRowCount: null,
    countLoading: false,
  };
}

function columnsForTable(
  schemaInfo: SchemaInfo | null,
  schemaName: string,
  tableName: string,
): string[] {
  if (!schemaInfo) return [];
  return schemaInfo.columns
    .filter((c) => c.schema === schemaName && c.table === tableName)
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((c) => c.name);
}

interface SessionState {
  // ── connection ──
  activeConfig: ConnectionConfig | null;
  connectionState: ConnectionState;
  connectionError: string | null;
  serverVersion: string | null;
  txnState: TxnState;

  // ── schema introspection ──
  schema: SchemaInfo | null;
  schemaLoading: boolean;
  expandedSchemas: Set<string>;
  /** The last-opened table, used to highlight the current row in the sidebar. */
  activeTable: { schema: string; name: string } | null;

  // ── tabs ──
  tabs: QueryTab[];
  activeTabId: string;

  // ── editor drawer ──
  editorExpanded: boolean;

  // ── dialogs & overlays ──
  dialogOpen: boolean;
  dialogPrefill: ConnectionConfig | null;
  paletteOpen: boolean;
  settingsOpen: boolean;
  historyOpen: boolean;
  deleteConfirmConnectionId: string | null;

  // ── saved connections ──
  savedConnections: SavedConnection[];

  // ── settings ──
  settings: Settings;

  // ── query history (cached copy for the history sheet) ──
  history: HistoryEntry[];

  // ── actions ──
  openDialog(prefill?: ConnectionConfig): void;
  closeDialog(): void;
  setPaletteOpen(open: boolean): void;
  togglePalette(): void;
  setSettingsOpen(open: boolean): void;
  setHistoryOpen(open: boolean): void;
  requestDeleteConnection(id: string | null): void;

  testConnection(config: ConnectionConfig): Promise<{ ok: boolean; message: string }>;
  connect(config: ConnectionConfig): Promise<void>;
  disconnect(): Promise<void>;
  refreshSchema(): Promise<void>;
  toggleSchema(name: string): void;

  // Per-tab actions operate on the active tab by default
  setSql(sql: string): void;
  runQuery(): Promise<void>;
  cancelQuery(): Promise<void>;
  openTable(schema: string, table: string): void;
  setPage(page: number): void;
  setPageSize(pageSize: number): void;
  setSort(index: number): void;
  setSelectedCell(cell: { row: number; col: number } | null): void;
  setColumnWidth(index: number, width: number): void;

  // Table-tab specific
  addFilter(filter: Filter): Promise<void>;
  updateFilter(id: string, patch: Partial<Filter>): Promise<void>;
  removeFilter(id: string): Promise<void>;
  clearFilters(): Promise<void>;
  setHiddenColumns(hidden: Set<string>): Promise<void>;
  toggleColumnHidden(column: string): Promise<void>;
  showAllColumns(): Promise<void>;
  refreshTable(): Promise<void>;

  // Tab management
  addTab(): void;
  closeTab(id: string): void;
  setActiveTab(id: string): void;
  renameActiveTab(title: string): void;

  toggleEditor(): void;
  setEditorExpanded(expanded: boolean): void;

  // Vault
  loadSavedConnections(): Promise<void>;
  connectSaved(id: string): Promise<void>;
  deleteSaved(id: string): Promise<void>;

  // Settings
  loadSettings(): Promise<void>;
  updateSettings(patch: Partial<Settings>): Promise<void>;
  toggleSidebar(): Promise<void>;
  toggleTheme(): Promise<void>;
  toggleFavoriteSchema(connectionId: string, schemaName: string): Promise<void>;
  toggleFavoriteTable(
    connectionId: string,
    schemaName: string,
    tableName: string,
  ): Promise<void>;
  /** Load a saved connection's full config (with password) and open the dialog in edit mode. */
  editConnection(id: string): Promise<void>;
  /** Update sidebar width (optimistic). Persistence is caller's responsibility. */
  setSidebarWidth(width: number): void;

  // History
  loadHistory(): Promise<void>;
  clearHistory(): Promise<void>;
  reuseHistoryQuery(sql: string): void;

  // Transactions
  beginTxn(): Promise<void>;
  commitTxn(): Promise<void>;
  rollbackTxn(): Promise<void>;
}

const initialTab = createEmptyTab(DEFAULT_SETTINGS.defaultPageSize);

export const useSession = create<SessionState>((set, get) => ({
  activeConfig: null,
  connectionState: 'idle',
  connectionError: null,
  serverVersion: null,
  txnState: 'none',

  schema: null,
  schemaLoading: false,
  expandedSchemas: new Set(),
  activeTable: null,

  tabs: [initialTab],
  activeTabId: initialTab.id,

  editorExpanded: false,

  dialogOpen: false,
  dialogPrefill: null,
  paletteOpen: false,
  settingsOpen: false,
  historyOpen: false,
  deleteConfirmConnectionId: null,

  savedConnections: [],

  settings: DEFAULT_SETTINGS,

  history: [],

  // ── dialog / palette / settings toggles ──

  openDialog: (prefill) => set({ dialogOpen: true, dialogPrefill: prefill ?? null }),
  closeDialog: () => set({ dialogOpen: false, dialogPrefill: null }),

  setPaletteOpen: (open) => set({ paletteOpen: open }),
  togglePalette: () => set({ paletteOpen: !get().paletteOpen }),

  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setHistoryOpen: (open) => set({ historyOpen: open }),

  requestDeleteConnection: (id) => set({ deleteConfirmConnectionId: id }),

  // ── connection ──

  async testConnection(config) {
    try {
      const res = await ipc.conn.test(config);
      if (res.ok) {
        return { ok: true, message: `Connected · ${shortVersion(res.serverVersion)}` };
      }
      return { ok: false, message: res.message };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  },

  async connect(config) {
    set({ connectionState: 'connecting', connectionError: null });
    try {
      const { serverVersion } = await ipc.conn.connect(config);
      set({
        activeConfig: config,
        serverVersion,
        connectionState: 'connected',
        dialogOpen: false,
        dialogPrefill: null,
        activeTable: null,
        txnState: 'none',
      });
      await Promise.all([get().refreshSchema(), get().loadSavedConnections()]);
      const schema = get().schema;
      if (schema && schema.schemas.length > 0) {
        const first = schema.schemas.find((s) => s.name === 'public') ?? schema.schemas[0];
        set({ expandedSchemas: new Set([first.name]) });
      }
    } catch (err) {
      set({
        connectionState: 'error',
        connectionError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  async connectSaved(id) {
    set({ connectionState: 'connecting', connectionError: null });
    try {
      const { info, config } = await ipc.vault.connectById(id);
      set({
        activeConfig: { ...config, password: '' },
        serverVersion: info.serverVersion,
        connectionState: 'connected',
        dialogOpen: false,
        dialogPrefill: null,
        activeTable: null,
        txnState: 'none',
      });
      await get().refreshSchema();
      const schema = get().schema;
      if (schema && schema.schemas.length > 0) {
        const first = schema.schemas.find((s) => s.name === 'public') ?? schema.schemas[0];
        set({ expandedSchemas: new Set([first.name]) });
      }
    } catch (err) {
      set({
        connectionState: 'error',
        connectionError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  async disconnect() {
    try {
      await ipc.conn.disconnect();
    } finally {
      set({
        activeConfig: null,
        serverVersion: null,
        connectionState: 'idle',
        schema: null,
        expandedSchemas: new Set(),
        activeTable: null,
        txnState: 'none',
      });
      // Clear all tabs' results since they reference a now-dead connection
      set((state) => ({
        tabs: state.tabs.map((t) => ({
          ...t,
          queryResult: null,
          queryError: null,
          page: 0,
          sortColumn: null,
          selectedCell: null,
        })),
      }));
    }
  },

  async refreshSchema() {
    set({ schemaLoading: true });
    try {
      const schema = await ipc.conn.introspect();
      set({ schema });
    } catch (err) {
      console.error('[plasma] introspect failed', err);
    } finally {
      set({ schemaLoading: false });
    }
  },

  toggleSchema(name) {
    const next = new Set(get().expandedSchemas);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    set({ expandedSchemas: next });
  },

  // ── per-tab actions ──

  setSql(sql) {
    patchActiveTab(set, get, { sql });
  },

  async runQuery() {
    const state = get();
    const tab = activeTab(state);
    if (!tab) return;
    if (tab.queryRunState === 'running') return;

    // Table tabs compile their SQL from structured state.
    if (tab.kind === 'table') {
      await runTableDataQuery(set, get, tab.id);
      void runTableCountQuery(set, get, tab.id);
      return;
    }

    const sql = tab.sql.trim();
    if (!sql) return;
    patchActiveTab(set, get, { queryRunState: 'running', queryError: null });
    try {
      const result = await ipc.query.run(sql);
      patchActiveTab(set, get, {
        queryResult: result,
        queryRunState: 'idle',
        page: 0,
        sortColumn: null,
        selectedCell: null,
      });
    } catch (err) {
      patchActiveTab(set, get, {
        queryError: err instanceof Error ? err.message : String(err),
        queryRunState: 'idle',
      });
    }
  },

  async cancelQuery() {
    try {
      await ipc.query.cancel();
    } catch (err) {
      console.error('[plasma] cancel failed', err);
    }
  },

  openTable(schemaName, tableName) {
    const state = get();
    // Reuse an existing table tab for the same schema+table
    const existing = state.tabs.find(
      (t) =>
        t.kind === 'table' &&
        t.tableSchema === schemaName &&
        t.tableName === tableName,
    );
    if (existing) {
      set({
        activeTabId: existing.id,
        activeTable: { schema: schemaName, name: tableName },
      });
      return;
    }
    // Create a fresh table tab and kick off data + count in parallel
    const tab = createTableTab(state.settings.defaultPageSize, schemaName, tableName);
    set({
      tabs: [...state.tabs, tab],
      activeTabId: tab.id,
      activeTable: { schema: schemaName, name: tableName },
    });
    void runTableDataQuery(set, get, tab.id);
    void runTableCountQuery(set, get, tab.id);
  },

  setSidebarWidth(width) {
    // Optimistic, no IPC. The caller (resizer pointerup) persists once.
    const clamped = Math.max(200, Math.min(520, Math.round(width)));
    set({ settings: { ...get().settings, sidebarWidth: clamped } });
  },

  setPage(page) {
    const tab = activeTab(get());
    if (!tab) return;
    const next = Math.max(0, page);
    patchActiveTab(set, get, { page: next });
    if (tab.kind === 'table') {
      void runTableDataQuery(set, get, tab.id);
    }
  },

  setPageSize(pageSize) {
    const tab = activeTab(get());
    if (!tab) return;
    patchActiveTab(set, get, { pageSize, page: 0 });
    void get().updateSettings({ defaultPageSize: pageSize });
    if (tab.kind === 'table') {
      void runTableDataQuery(set, get, tab.id);
    }
  },

  setSort(index) {
    const tab = activeTab(get());
    if (!tab) return;

    if (tab.kind === 'table') {
      // Server-side sort: cycle none → asc → desc → none on the column name
      const columnName = tab.queryResult?.columns[index]?.name;
      if (!columnName) return;
      const current = tab.tableSort.find((s) => s.column === columnName);
      let nextSort: TableSort[];
      if (!current) {
        nextSort = [{ column: columnName, direction: 'asc' }];
      } else if (current.direction === 'asc') {
        nextSort = [{ column: columnName, direction: 'desc' }];
      } else {
        nextSort = [];
      }
      patchActiveTab(set, get, { tableSort: nextSort, page: 0 });
      void runTableDataQuery(set, get, tab.id);
      return;
    }

    // Client-side sort for SQL tabs
    let nextSort: { index: number; direction: 'asc' | 'desc' } | null;
    if (!tab.sortColumn || tab.sortColumn.index !== index) {
      nextSort = { index, direction: 'asc' };
    } else if (tab.sortColumn.direction === 'asc') {
      nextSort = { index, direction: 'desc' };
    } else {
      nextSort = null;
    }
    patchActiveTab(set, get, { sortColumn: nextSort, page: 0 });
  },

  setSelectedCell(cell) {
    patchActiveTab(set, get, { selectedCell: cell });
  },

  setColumnWidth(index, width) {
    const tab = activeTab(get());
    if (!tab) return;
    patchActiveTab(set, get, {
      columnWidths: { ...tab.columnWidths, [index]: width },
    });
  },

  // ── Table-tab specific actions ──

  async addFilter(filter) {
    const tab = activeTab(get());
    if (!tab || tab.kind !== 'table') return;
    patchActiveTab(set, get, {
      filters: [...tab.filters, filter],
      page: 0,
    });
    await runTableDataQuery(set, get, tab.id);
    void runTableCountQuery(set, get, tab.id);
  },

  async updateFilter(id, patch) {
    const tab = activeTab(get());
    if (!tab || tab.kind !== 'table') return;
    const nextFilters = tab.filters.map((f) => (f.id === id ? { ...f, ...patch } : f));
    patchActiveTab(set, get, { filters: nextFilters, page: 0 });
    await runTableDataQuery(set, get, tab.id);
    void runTableCountQuery(set, get, tab.id);
  },

  async removeFilter(id) {
    const tab = activeTab(get());
    if (!tab || tab.kind !== 'table') return;
    patchActiveTab(set, get, {
      filters: tab.filters.filter((f) => f.id !== id),
      page: 0,
    });
    await runTableDataQuery(set, get, tab.id);
    void runTableCountQuery(set, get, tab.id);
  },

  async clearFilters() {
    const tab = activeTab(get());
    if (!tab || tab.kind !== 'table') return;
    patchActiveTab(set, get, { filters: [], page: 0 });
    await runTableDataQuery(set, get, tab.id);
    void runTableCountQuery(set, get, tab.id);
  },

  async setHiddenColumns(hidden) {
    const tab = activeTab(get());
    if (!tab || tab.kind !== 'table') return;
    patchActiveTab(set, get, { hiddenColumns: hidden });
    await runTableDataQuery(set, get, tab.id);
  },

  async toggleColumnHidden(column) {
    const tab = activeTab(get());
    if (!tab || tab.kind !== 'table') return;
    const next = new Set(tab.hiddenColumns);
    if (next.has(column)) next.delete(column);
    else next.add(column);
    patchActiveTab(set, get, { hiddenColumns: next });
    await runTableDataQuery(set, get, tab.id);
  },

  async showAllColumns() {
    const tab = activeTab(get());
    if (!tab || tab.kind !== 'table') return;
    patchActiveTab(set, get, { hiddenColumns: new Set() });
    await runTableDataQuery(set, get, tab.id);
  },

  async refreshTable() {
    const tab = activeTab(get());
    if (!tab || tab.kind !== 'table') return;
    await runTableDataQuery(set, get, tab.id);
    void runTableCountQuery(set, get, tab.id);
  },

  // ── tabs ──

  addTab() {
    const state = get();
    const pageSize = state.settings.defaultPageSize;
    const n = state.tabs.length + 1;
    const tab = createEmptyTab(pageSize, `query-${n}.sql`);
    set({ tabs: [...state.tabs, tab], activeTabId: tab.id });
  },

  closeTab(id) {
    const state = get();
    if (state.tabs.length === 1) {
      // Don't close the last tab — reset it instead
      const fresh = createEmptyTab(state.settings.defaultPageSize);
      set({ tabs: [fresh], activeTabId: fresh.id });
      return;
    }
    const idx = state.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const nextTabs = state.tabs.filter((t) => t.id !== id);
    let nextActive = state.activeTabId;
    if (state.activeTabId === id) {
      nextActive = nextTabs[Math.min(idx, nextTabs.length - 1)].id;
    }
    set({ tabs: nextTabs, activeTabId: nextActive });
  },

  setActiveTab(id) {
    if (get().tabs.some((t) => t.id === id)) set({ activeTabId: id });
  },

  renameActiveTab(title) {
    patchActiveTab(set, get, { title });
  },

  // ── editor drawer ──

  toggleEditor() {
    set({ editorExpanded: !get().editorExpanded });
  },

  setEditorExpanded(expanded) {
    set({ editorExpanded: expanded });
  },

  // ── vault ──

  async loadSavedConnections() {
    try {
      const saved = await ipc.vault.list();
      set({ savedConnections: saved });
    } catch (err) {
      console.error('[plasma] vault.list failed', err);
    }
  },

  async deleteSaved(id) {
    try {
      await ipc.vault.delete(id);
    } finally {
      set({ deleteConfirmConnectionId: null });
      await get().loadSavedConnections();
    }
  },

  // ── settings ──

  async loadSettings() {
    try {
      const settings = await ipc.settings.get();
      set({ settings });
      // Apply theme immediately on boot
      document.documentElement.dataset.theme = settings.theme;
    } catch (err) {
      console.error('[plasma] settings.get failed', err);
    }
  },

  async updateSettings(patch) {
    try {
      const next = await ipc.settings.set(patch);
      set({ settings: next });
      document.documentElement.dataset.theme = next.theme;
    } catch (err) {
      console.error('[plasma] settings.set failed', err);
    }
  },

  async toggleSidebar() {
    // Optimistic UI update first so the panel flips instantly.
    // Persistence to SQLite is fire-and-forget — any failure is logged
    // but never blocks the interaction.
    const next = !get().settings.sidebarCollapsed;
    set({ settings: { ...get().settings, sidebarCollapsed: next } });
    try {
      await ipc.settings.set({ sidebarCollapsed: next });
    } catch (err) {
      console.error('[plasma] persist sidebarCollapsed failed', err);
    }
  },

  async toggleTheme() {
    // Optimistic theme flip — apply CSS immediately, persist in background.
    const next = get().settings.theme === 'paper' ? 'midnight' : 'paper';
    set({ settings: { ...get().settings, theme: next } });
    document.documentElement.dataset.theme = next;
    try {
      await ipc.settings.set({ theme: next });
    } catch (err) {
      console.error('[plasma] persist theme failed', err);
    }
  },

  async toggleFavoriteSchema(connectionId: string, schemaName: string) {
    const current = get().settings.favoriteSchemas ?? {};
    const forConn = new Set(current[connectionId] ?? []);
    if (forConn.has(schemaName)) forConn.delete(schemaName);
    else forConn.add(schemaName);
    const nextMap = {
      ...current,
      [connectionId]: Array.from(forConn).sort(),
    };
    // Optimistic
    set({ settings: { ...get().settings, favoriteSchemas: nextMap } });
    try {
      await ipc.settings.set({ favoriteSchemas: nextMap });
    } catch (err) {
      console.error('[plasma] persist favoriteSchemas failed', err);
    }
  },

  async toggleFavoriteTable(connectionId, schemaName, tableName) {
    const current = get().settings.favoriteTables ?? {};
    const key = `${schemaName}.${tableName}`;
    const forConn = new Set(current[connectionId] ?? []);
    if (forConn.has(key)) forConn.delete(key);
    else forConn.add(key);
    const nextMap = {
      ...current,
      [connectionId]: Array.from(forConn).sort(),
    };
    set({ settings: { ...get().settings, favoriteTables: nextMap } });
    try {
      await ipc.settings.set({ favoriteTables: nextMap });
    } catch (err) {
      console.error('[plasma] persist favoriteTables failed', err);
    }
  },

  async editConnection(id) {
    try {
      const config = await ipc.vault.getConfig(id);
      if (!config) {
        console.error('[plasma] editConnection: no saved connection with id', id);
        return;
      }
      get().openDialog(config);
    } catch (err) {
      console.error('[plasma] editConnection failed', err);
    }
  },

  // ── history ──

  async loadHistory() {
    try {
      const history = await ipc.history.list({ limit: 500 });
      set({ history });
    } catch (err) {
      console.error('[plasma] history.list failed', err);
    }
  },

  async clearHistory() {
    await ipc.history.clear();
    set({ history: [] });
  },

  reuseHistoryQuery(sql) {
    patchActiveTab(set, get, { sql });
    set({ historyOpen: false, editorExpanded: true });
  },

  // ── transactions ──

  async beginTxn() {
    try {
      const state = await ipc.txn.begin();
      set({ txnState: state });
    } catch (err) {
      console.error('[plasma] beginTxn failed', err);
    }
  },

  async commitTxn() {
    try {
      const state = await ipc.txn.commit();
      set({ txnState: state });
    } catch (err) {
      console.error('[plasma] commitTxn failed', err);
    }
  },

  async rollbackTxn() {
    try {
      const state = await ipc.txn.rollback();
      set({ txnState: state });
    } catch (err) {
      console.error('[plasma] rollbackTxn failed', err);
    }
  },
}));

// ─── Helpers ─────────────────────────────────────────────────────────

export function activeTab(state: SessionState): QueryTab | undefined {
  return state.tabs.find((t) => t.id === state.activeTabId);
}

function patchActiveTab(
  set: (fn: (s: SessionState) => Partial<SessionState>) => void,
  get: () => SessionState,
  patch: Partial<QueryTab>,
) {
  const activeId = get().activeTabId;
  set((state) => ({
    tabs: state.tabs.map((t) => (t.id === activeId ? { ...t, ...patch } : t)),
  }));
}

function patchTabById(
  set: (fn: (s: SessionState) => Partial<SessionState>) => void,
  tabId: string,
  patch: Partial<QueryTab>,
) {
  set((state) => ({
    tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)),
  }));
}

/**
 * Compile + run the data query for a table tab. Used on open, page
 * change, sort change, filter change, column visibility change.
 */
async function runTableDataQuery(
  set: (fn: (s: SessionState) => Partial<SessionState>) => void,
  get: () => SessionState,
  tabId: string,
) {
  const state = get();
  const tab = state.tabs.find((t) => t.id === tabId);
  if (!tab || tab.kind !== 'table' || !tab.tableSchema || !tab.tableName) return;

  const allColumns = columnsForTable(state.schema, tab.tableSchema, tab.tableName);
  const { sql, params } = buildDataSql({
    schema: tab.tableSchema,
    table: tab.tableName,
    allColumns,
    hiddenColumns: tab.hiddenColumns,
    sort: tab.tableSort,
    filters: tab.filters,
    page: tab.page,
    pageSize: tab.pageSize,
  });

  patchTabById(set, tabId, {
    queryRunState: 'running',
    queryError: null,
    sql, // store for display / copy
  });

  try {
    const result = await ipc.query.run(sql, params);
    patchTabById(set, tabId, {
      queryResult: result,
      queryRunState: 'idle',
      selectedCell: null,
    });
  } catch (err) {
    patchTabById(set, tabId, {
      queryError: err instanceof Error ? err.message : String(err),
      queryRunState: 'idle',
    });
  }
}

/**
 * Background count query for a table tab. Runs in parallel with the
 * data query so pagination totals arrive without blocking the user's
 * view of the first page.
 */
async function runTableCountQuery(
  set: (fn: (s: SessionState) => Partial<SessionState>) => void,
  get: () => SessionState,
  tabId: string,
) {
  const state = get();
  const tab = state.tabs.find((t) => t.id === tabId);
  if (!tab || tab.kind !== 'table' || !tab.tableSchema || !tab.tableName) return;

  patchTabById(set, tabId, { countLoading: true });
  const { sql, params } = buildCountSql({
    schema: tab.tableSchema,
    table: tab.tableName,
    filters: tab.filters,
  });

  try {
    const result = await ipc.query.run(sql, params);
    const raw = result.rows[0]?.[0];
    const count = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number(raw);
    patchTabById(set, tabId, {
      totalRowCount: Number.isFinite(count) ? count : null,
      countLoading: false,
    });
  } catch {
    patchTabById(set, tabId, { countLoading: false });
  }
}

function shortVersion(full: string): string {
  const m = full.match(/^(PostgreSQL\s+[\d.]+)/);
  return m ? m[1] : full;
}

/** React hook helper: selects the currently active tab with proper memoization. */
export function useActiveTab(): QueryTab | undefined {
  return useSession((s) => s.tabs.find((t) => t.id === s.activeTabId));
}
