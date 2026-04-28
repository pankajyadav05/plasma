import { ipc } from '@/lib/ipc';
import {
  type Filter,
  type TableSort,
  buildCountSql,
  buildDataSql,
  buildDeleteSql,
  buildEstimatedCountSql,
  buildInsertSql,
  buildRlsCountSql,
  buildRolesSql,
  buildUpdateSql,
} from '@/lib/table-query';
import type {
  ConnectionConfig,
  HistoryEntry,
  QueryResult,
  SavedConnection,
  SchemaInfo,
  Settings,
  TxnState,
} from '@shared/protocol';
import { create } from 'zustand';

/**
 * When a table is unfiltered AND the introspected estimate is above this
 * threshold, we use pg_class.reltuples instead of COUNT(*). For small
 * tables COUNT(*) is cheap and accurate; for huge tables it can take
 * minutes.
 */
const ESTIMATED_COUNT_THRESHOLD = 1_000_000;

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
export type TableViewMode = 'data' | 'definition';
export type EntityKind = 'table' | 'view' | 'matview' | 'foreign' | 'partitioned';
/** Drives what the main right-side canvas renders. Switched from IconRail. */
export type CanvasMode = 'database' | 'sql' | 'history' | 'settings';
/** Which slot of the right rail is currently expanded. null = collapsed. */
export type RightPanelMode = 'query' | 'role' | 'rls' | null;

/**
 * Cheap heuristic for DDL detection. We strip leading comments/whitespace
 * and look for a top-level keyword that implies the schema graph has
 * changed. Not a parser — false positives on DML containing the word
 * `create` inside a string literal are acceptable (worst case is one
 * extra introspect call).
 */
function looksLikeDdl(sql: string): boolean {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*--.*$/gm, '')
    .trim()
    .toLowerCase();
  return /^(create|alter|drop|rename|truncate|comment|grant|revoke|vacuum|reindex|cluster)\b/.test(
    stripped,
  );
}

/**
 * Build a stable key for per-table column state persistence. We prefix
 * with the connection id so two tables with the same schema.name across
 * different databases don't collide.
 */
function columnStateKey(
  connectionId: string | null | undefined,
  schemaName: string,
  tableName: string,
): string {
  return `${connectionId ?? '_'}:${schemaName}.${tableName}`;
}

// Debounce handle for column-width drag persistence. During a drag we
// rewrite the tab's columnWidths on every pointermove — we only want
// to hit IPC + disk once, when the user actually lets go.
let columnWidthPersistTimer: ReturnType<typeof setTimeout> | null = null;

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
  queryErrorSql: string | null;
  page: number;
  pageSize: number;
  selectedCell: { row: number; col: number } | null;
  /**
   * Page-scoped row selection — indices into the currently rendered
   * `displayRows` array. Used for "export selected" / "copy selected".
   * Cleared whenever the visible rows change (page / sort / re-run).
   */
  selectedRows: Set<number>;
  columnWidths: Record<number, number>;

  // ── SQL tab fields (client-side sort) ──
  sortColumn: { index: number; direction: 'asc' | 'desc' } | null;

  // ── Table tab fields (server-side sort/filter/hide) ──
  tableSchema?: string;
  tableName?: string;
  tableSort: TableSort[];
  filters: Filter[];
  hiddenColumns: Set<string>;
  stickyColumns: Set<string>;
  totalRowCount: number | null;
  /** True when totalRowCount comes from pg_class.reltuples, not COUNT(*). */
  totalRowCountIsEstimate: boolean;
  countLoading: boolean;
  /** Table tabs: 'data' = grid, 'definition' = DDL. SQL tabs ignore. */
  viewMode: TableViewMode;
  /** RLS policy count for the table backing this tab. null = not yet loaded. */
  rlsPolicyCount: number | null;
}

const THEME_NAMES = [
  'default',
  'catppuccin',
  'claude',
  'claymorphism',
  'neo-brutalism',
  'quantum-rose',
  'forest-canopy',
  'cyberpunk',
  'arctic',
] as const;

const FONT_SANS_STACKS: Record<string, string> = {
  geist: "'Geist', ui-sans-serif, system-ui, -apple-system, sans-serif",
  inter: "'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif",
  outfit: "'Outfit', ui-sans-serif, system-ui, -apple-system, sans-serif",
  'plus-jakarta': "'Plus Jakarta Sans', ui-sans-serif, system-ui, -apple-system, sans-serif",
  'ibm-plex': "'IBM Plex Sans', ui-sans-serif, system-ui, -apple-system, sans-serif",
  system:
    "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
};

const FONT_MONO_STACKS: Record<string, string> = {
  'jetbrains-mono': "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  'geist-mono': "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  'ibm-plex-mono': "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  system: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
};

function applyTheme(mode: 'light' | 'dark', name: string) {
  const root = document.documentElement;
  root.classList.toggle('dark', mode === 'dark');
  for (const n of THEME_NAMES) root.classList.remove(`theme-${n}`);
  if (name && name !== 'default') root.classList.add(`theme-${name}`);
  // Notify non-CSS consumers (Monaco, future canvases) that live vars changed.
  window.dispatchEvent(new CustomEvent('plasma:theme-changed', { detail: { mode, name } }));
}

// Inline `--font-*` overrides on <html>. Beats theme-class vars by source
// order + specificity (inline style wins over any class rule). When the
// user resets to 'theme', we removeProperty so the theme's choice
// resurfaces cleanly.
function applyFonts(sans: string, mono: string) {
  const root = document.documentElement;
  if (sans === 'theme' || !FONT_SANS_STACKS[sans]) {
    root.style.removeProperty('--font-sans');
  } else {
    root.style.setProperty('--font-sans', FONT_SANS_STACKS[sans]);
  }
  if (mono === 'theme' || !FONT_MONO_STACKS[mono]) {
    root.style.removeProperty('--font-mono');
  } else {
    root.style.setProperty('--font-mono', FONT_MONO_STACKS[mono]);
  }
}

const DEFAULT_SETTINGS: Settings = {
  theme: 'light',
  themeName: 'default',
  fontSans: 'theme',
  fontMono: 'theme',
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
  tableColumnState: {},
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
    queryErrorSql: null,
    page: 0,
    pageSize,
    sortColumn: null,
    selectedCell: null,
    selectedRows: new Set(),
    columnWidths: {},
    tableSort: [],
    filters: [],
    hiddenColumns: new Set(),
    stickyColumns: new Set(),
    totalRowCount: null,
    totalRowCountIsEstimate: false,
    countLoading: false,
    viewMode: 'data',
    rlsPolicyCount: null,
  };
}

function createTableTab(pageSize: number, schemaName: string, tableName: string): QueryTab {
  const title = schemaName === 'public' ? tableName : `${schemaName}.${tableName}`;
  return {
    id: freshId(),
    title,
    kind: 'table',
    sql: '',
    queryRunState: 'idle',
    queryResult: null,
    queryError: null,
    queryErrorSql: null,
    page: 0,
    pageSize,
    sortColumn: null,
    selectedCell: null,
    selectedRows: new Set(),
    columnWidths: {},
    tableSchema: schemaName,
    tableName,
    tableSort: [],
    filters: [],
    hiddenColumns: new Set(),
    stickyColumns: new Set(),
    totalRowCount: null,
    totalRowCountIsEstimate: false,
    countLoading: false,
    viewMode: 'data',
    rlsPolicyCount: null,
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

function columnMetaFor(
  schemaInfo: SchemaInfo | null,
  schemaName: string,
  tableName: string,
): SchemaInfo['columns'] {
  if (!schemaInfo) return [];
  return schemaInfo.columns
    .filter((c) => c.schema === schemaName && c.table === tableName)
    .sort((a, b) => a.ordinal - b.ordinal);
}

/**
 * Given a row from a table tab's current query result, pull the PK
 * column values so we can build an UPDATE / DELETE WHERE clause. Returns
 * null if the table has no primary key (row-editing is refused in that
 * case — we never issue an unqualified write).
 */
function pkValuesForRow(
  schemaInfo: SchemaInfo | null,
  tab: QueryTab,
  row: unknown[],
): Record<string, unknown> | null {
  if (!tab.queryResult || !tab.tableSchema || !tab.tableName) return null;
  const pkCols = (schemaInfo?.columns ?? []).filter(
    (c) => c.schema === tab.tableSchema && c.table === tab.tableName && c.isPrimaryKey,
  );
  if (pkCols.length === 0) return null;
  const nameToIndex = new Map(tab.queryResult.columns.map((c, i) => [c.name, i] as const));
  const out: Record<string, unknown> = {};
  for (const pk of pkCols) {
    const idx = nameToIndex.get(pk.name);
    if (idx === undefined) return null; // PK column not in SELECT — refuse
    out[pk.name] = row[idx];
  }
  return out;
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

  /** Drives what the main right-side canvas renders. */
  canvasMode: CanvasMode;
  /** Current schema selection for the entity list. */
  currentSchema: string | null;
  /** Entity-kind filter for the entity list. */
  entityFilter: Set<EntityKind>;

  // ── role + RLS ──
  /** The role currently SET on the worker connection. null = backend default. */
  activeRole: string | null;
  availableRoles: string[];

  // ── right rail panel ──
  /** Which panel is open in the right-side rail. null = collapsed. */
  rightPanelMode: RightPanelMode;

  // ── edit mode ──
  /** Global safety gate for writes. When false, all mutation UI is hidden. */
  editMode: boolean;

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
  toggleEditMode(): void;
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
  openForeignRow(refSchema: string, refTable: string, refColumn: string, value: unknown): void;
  setPage(page: number): void;
  setPageSize(pageSize: number): void;
  setSort(index: number): void;

  toggleRowSelected(idx: number): void;
  setSelectedRows(rows: Set<number>): void;
  clearSelectedRows(): void;
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
  toggleStickyColumn(column: string): void;
  clearStickyColumns(): void;
  refreshTable(): Promise<void>;

  // Row editing (table tabs, edit mode only)
  updateCell(rowIndex: number, columnIndex: number, newValue: string | null): Promise<void>;
  insertRow(values: Record<string, string | null>): Promise<void>;
  deleteRow(rowIndex: number): Promise<void>;

  // Tab management
  addTab(): void;
  closeTab(id: string): void;
  setActiveTab(id: string): void;
  renameActiveTab(title: string): void;
  setTabViewMode(mode: TableViewMode): void;

  // Canvas mode + entity filtering
  setCanvasMode(mode: CanvasMode): void;
  setCurrentSchema(name: string | null): void;
  setEntityFilter(kinds: Set<EntityKind>): void;
  toggleEntityFilter(kind: EntityKind): void;

  // Role + RLS
  loadAvailableRoles(): Promise<void>;
  setActiveRole(role: string | null): Promise<void>;
  loadRlsForActiveTab(): Promise<void>;

  toggleEditor(): void;
  setEditorExpanded(expanded: boolean): void;
  setRightPanelMode(mode: RightPanelMode): void;

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
  toggleFavoriteTable(connectionId: string, schemaName: string, tableName: string): Promise<void>;
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

  canvasMode: 'database',
  currentSchema: null,
  entityFilter: new Set<EntityKind>(['table', 'view', 'matview', 'foreign', 'partitioned']),

  activeRole: null,
  availableRoles: [],

  rightPanelMode: null,

  editMode: false,

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

  toggleEditMode: () => set({ editMode: !get().editMode }),

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
        set({ expandedSchemas: new Set([first.name]), currentSchema: first.name });
      }
      void get().loadAvailableRoles();
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
        set({ expandedSchemas: new Set([first.name]), currentSchema: first.name });
      }
      void get().loadAvailableRoles();
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
        currentSchema: null,
        availableRoles: [],
        activeRole: null,
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
          selectedRows: new Set(),
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
    patchActiveTab(set, get, {
      queryRunState: 'running',
      queryError: null,
      queryErrorSql: null,
    });
    try {
      const result = await ipc.query.run(sql);
      patchActiveTab(set, get, {
        queryResult: result,
        queryRunState: 'idle',
        page: 0,
        sortColumn: null,
        selectedCell: null,
        selectedRows: new Set(),
      });
      // DDL auto-refresh: if the user just ran CREATE / ALTER / DROP /
      // RENAME / TRUNCATE / COMMENT, the introspected schema is now
      // stale — re-fetch so the sidebar reflects the change without
      // forcing a manual reconnect. We fire-and-forget so the grid
      // updates immediately.
      if (looksLikeDdl(sql)) {
        void get().refreshSchema();
      }
    } catch (err) {
      patchActiveTab(set, get, {
        queryError: err instanceof Error ? err.message : String(err),
        queryErrorSql: sql,
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
      (t) => t.kind === 'table' && t.tableSchema === schemaName && t.tableName === tableName,
    );
    if (existing) {
      set({
        activeTabId: existing.id,
        activeTable: { schema: schemaName, name: tableName },
      });
      return;
    }
    // Create a fresh table tab, then layer any persisted column state
    // (widths / hidden / sticky) ON TOP before kicking off the query —
    // hiddenColumns in particular has to be set before the SELECT is
    // compiled so the server doesn't return columns we're about to hide.
    const baseTab = createTableTab(state.settings.defaultPageSize, schemaName, tableName);
    const persistedPatch = loadTableColumnStateInto(state, schemaName, tableName);
    const tab: QueryTab = { ...baseTab, ...persistedPatch };
    set({
      tabs: [...state.tabs, tab],
      activeTabId: tab.id,
      activeTable: { schema: schemaName, name: tableName },
    });
    void runTableDataQuery(set, get, tab.id);
    void runTableCountQuery(set, get, tab.id);
    void runRlsCountForTab(set, get, tab.id);
  },

  openForeignRow(refSchema, refTable, refColumn, value) {
    // FK click-through: open the referenced table as a fresh table tab
    // with an equality filter on the referenced column pre-applied. We
    // always create a new tab so prior FK navigations stay inspectable.
    if (value === null || value === undefined) return;
    const state = get();
    const baseTab = createTableTab(state.settings.defaultPageSize, refSchema, refTable);
    const persistedPatch = loadTableColumnStateInto(state, refSchema, refTable);
    const filter: Filter = {
      id: `fk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      column: refColumn,
      op: '=',
      value: String(value),
    };
    const tab: QueryTab = { ...baseTab, ...persistedPatch, filters: [filter] };
    set({
      tabs: [...state.tabs, tab],
      activeTabId: tab.id,
      activeTable: { schema: refSchema, name: refTable },
    });
    void runTableDataQuery(set, get, tab.id);
    void runTableCountQuery(set, get, tab.id);
    void runRlsCountForTab(set, get, tab.id);
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
    patchActiveTab(set, get, { page: next, selectedRows: new Set() });
    if (tab.kind === 'table') {
      void runTableDataQuery(set, get, tab.id);
    }
  },

  setPageSize(pageSize) {
    const tab = activeTab(get());
    if (!tab) return;
    patchActiveTab(set, get, { pageSize, page: 0, selectedRows: new Set() });
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

  toggleRowSelected(idx) {
    const tab = activeTab(get());
    if (!tab) return;
    const next = new Set(tab.selectedRows);
    if (next.has(idx)) next.delete(idx);
    else next.add(idx);
    patchActiveTab(set, get, { selectedRows: next });
  },

  setSelectedRows(rows) {
    patchActiveTab(set, get, { selectedRows: rows });
  },

  clearSelectedRows() {
    patchActiveTab(set, get, { selectedRows: new Set() });
  },

  setColumnWidth(index, width) {
    const tab = activeTab(get());
    if (!tab) return;
    patchActiveTab(set, get, {
      columnWidths: { ...tab.columnWidths, [index]: width },
    });
    // Drag fires this on every pointermove — debounce the IPC write so
    // we only persist once the user lets go of the handle.
    if (tab.kind === 'table') {
      if (columnWidthPersistTimer) clearTimeout(columnWidthPersistTimer);
      columnWidthPersistTimer = setTimeout(() => {
        persistTableColumnState(set, get);
        columnWidthPersistTimer = null;
      }, 300);
    }
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
    if (!tab) return;
    const next = new Set(tab.hiddenColumns);
    if (next.has(column)) next.delete(column);
    else next.add(column);
    patchActiveTab(set, get, { hiddenColumns: next });
    if (tab.kind === 'table') {
      await runTableDataQuery(set, get, tab.id);
      persistTableColumnState(set, get);
    }
  },

  async showAllColumns() {
    const tab = activeTab(get());
    if (!tab) return;
    patchActiveTab(set, get, { hiddenColumns: new Set() });
    if (tab.kind === 'table') {
      await runTableDataQuery(set, get, tab.id);
      persistTableColumnState(set, get);
    }
  },

  toggleStickyColumn(column) {
    const tab = activeTab(get());
    if (!tab) return;
    const next = new Set(tab.stickyColumns);
    if (next.has(column)) next.delete(column);
    else next.add(column);
    patchActiveTab(set, get, { stickyColumns: next });
    persistTableColumnState(set, get);
  },

  clearStickyColumns() {
    const tab = activeTab(get());
    if (!tab) return;
    patchActiveTab(set, get, { stickyColumns: new Set() });
    persistTableColumnState(set, get);
  },

  async refreshTable() {
    const tab = activeTab(get());
    if (!tab || tab.kind !== 'table') return;
    await runTableDataQuery(set, get, tab.id);
    void runTableCountQuery(set, get, tab.id);
  },

  // ── row editing (table tabs only, gated by editMode) ──

  async updateCell(rowIndex, columnIndex, newValue) {
    const state = get();
    if (!state.editMode) throw new Error('edit mode is off');
    const tab = activeTab(state);
    if (!tab || tab.kind !== 'table' || !tab.tableSchema || !tab.tableName) return;
    if (!tab.queryResult) return;

    const col = tab.queryResult.columns[columnIndex];
    if (!col) return;
    const row = tab.queryResult.rows[rowIndex];
    if (!row) return;

    const pkValues = pkValuesForRow(state.schema, tab, row);
    if (!pkValues) {
      throw new Error('table has no primary key — cannot edit rows safely');
    }

    const { sql, params } = buildUpdateSql({
      schema: tab.tableSchema,
      table: tab.tableName,
      set: { [col.name]: newValue },
      pkValues,
    });
    await ipc.query.run(sql, params, { internal: true });
    await runTableDataQuery(set, get, tab.id);
  },

  async insertRow(values) {
    const state = get();
    if (!state.editMode) throw new Error('edit mode is off');
    const tab = activeTab(state);
    if (!tab || tab.kind !== 'table' || !tab.tableSchema || !tab.tableName) return;

    // Drop empty strings on columns with defaults — let Postgres apply them.
    const cols = columnMetaFor(state.schema, tab.tableSchema, tab.tableName);
    const toInsert: Record<string, unknown> = {};
    for (const c of cols) {
      const raw = values[c.name];
      if (raw === undefined) continue;
      if (raw === '' && c.hasDefault) continue;
      toInsert[c.name] = raw === '' && c.isNullable ? null : raw;
    }
    if (Object.keys(toInsert).length === 0) {
      throw new Error('nothing to insert');
    }

    const { sql, params } = buildInsertSql({
      schema: tab.tableSchema,
      table: tab.tableName,
      values: toInsert,
    });
    await ipc.query.run(sql, params, { internal: true });
    await runTableDataQuery(set, get, tab.id);
    void runTableCountQuery(set, get, tab.id);
  },

  async deleteRow(rowIndex) {
    const state = get();
    if (!state.editMode) throw new Error('edit mode is off');
    const tab = activeTab(state);
    if (!tab || tab.kind !== 'table' || !tab.tableSchema || !tab.tableName) return;
    if (!tab.queryResult) return;

    const row = tab.queryResult.rows[rowIndex];
    if (!row) return;

    const pkValues = pkValuesForRow(state.schema, tab, row);
    if (!pkValues) {
      throw new Error('table has no primary key — cannot delete rows safely');
    }

    const { sql, params } = buildDeleteSql({
      schema: tab.tableSchema,
      table: tab.tableName,
      pkValues,
    });
    await ipc.query.run(sql, params, { internal: true });
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

  // ── canvas mode + entity filtering ──

  setCanvasMode(mode) {
    set({ canvasMode: mode });
  },

  setCurrentSchema(name) {
    set({ currentSchema: name });
  },

  setEntityFilter(kinds) {
    set({ entityFilter: new Set(kinds) });
  },

  toggleEntityFilter(kind) {
    const next = new Set(get().entityFilter);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    set({ entityFilter: next });
  },

  setTabViewMode(mode) {
    patchActiveTab(set, get, { viewMode: mode });
  },

  // ── role + RLS ──

  async loadAvailableRoles() {
    try {
      const { sql, params } = buildRolesSql();
      const res = await ipc.query.run(sql, params, { internal: true });
      const roles = res.rows.map((r) => (r[0] as string | null) ?? '').filter((s) => s.length > 0);
      set({ availableRoles: roles });
    } catch (err) {
      console.error('[plasma] loadAvailableRoles failed', err);
    }
  },

  async setActiveRole(role) {
    try {
      if (role === null) {
        await ipc.query.run('RESET ROLE', undefined, { internal: true });
      } else {
        // Identifier interpolation is unavoidable for SET ROLE; we
        // cross-check against the loaded role list so an unfamiliar name
        // gets rejected client-side first.
        const allowed = get().availableRoles.includes(role);
        if (!allowed) throw new Error(`unknown role: ${role}`);
        const safe = role.replace(/"/g, '""');
        await ipc.query.run(`SET ROLE "${safe}"`, undefined, { internal: true });
      }
      set({ activeRole: role });
      // Re-run the active table tab so the new role's RLS policies apply.
      const tab = activeTab(get());
      if (tab?.kind === 'table') {
        void runTableDataQuery(set, get, tab.id);
        void runTableCountQuery(set, get, tab.id);
      }
    } catch (err) {
      console.error('[plasma] setActiveRole failed', err);
    }
  },

  async loadRlsForActiveTab() {
    const state = get();
    const tab = activeTab(state);
    if (!tab || tab.kind !== 'table' || !tab.tableSchema || !tab.tableName) return;
    try {
      const { sql, params } = buildRlsCountSql(tab.tableSchema, tab.tableName);
      const res = await ipc.query.run(sql, params, { internal: true });
      const raw = res.rows[0]?.[0];
      const count = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number(raw);
      patchTabById(set, tab.id, {
        rlsPolicyCount: Number.isFinite(count) ? count : 0,
      });
    } catch (err) {
      console.error('[plasma] loadRlsForActiveTab failed', err);
    }
  },

  // ── right rail panel ──

  toggleEditor() {
    // Backward-compat: cycles the query slot of the right rail.
    set({ rightPanelMode: get().rightPanelMode === 'query' ? null : 'query' });
  },

  setEditorExpanded(expanded) {
    // Backward-compat: callers that want to "open the editor" still
    // map cleanly to opening the query panel.
    set({ rightPanelMode: expanded ? 'query' : null });
  },

  setRightPanelMode(mode) {
    set({ rightPanelMode: mode });
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
      // Apply theme + font overrides immediately on boot
      applyTheme(settings.theme, settings.themeName);
      applyFonts(settings.fontSans, settings.fontMono);
    } catch (err) {
      console.error('[plasma] settings.get failed', err);
    }
  },

  async updateSettings(patch) {
    try {
      const next = await ipc.settings.set(patch);
      set({ settings: next });
      applyTheme(next.theme, next.themeName);
      applyFonts(next.fontSans, next.fontMono);
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
    const next = get().settings.theme === 'light' ? 'dark' : 'light';
    set({ settings: { ...get().settings, theme: next } });
    applyTheme(next, get().settings.themeName);
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
    set({ historyOpen: false, rightPanelMode: 'query' });
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

/**
 * Persist the active table tab's column state (widths / hidden / sticky)
 * to settings. Widths stored in the tab are index-keyed; we translate to
 * name-keyed for persistence so schema reorderings don't misalign the
 * restored widths.
 *
 * Fire-and-forget — failures are logged but don't surface to the user.
 * Called after any column-level mutation on a table tab.
 */
function persistTableColumnState(
  set: (fn: (s: SessionState) => Partial<SessionState>) => void,
  get: () => SessionState,
) {
  const state = get();
  const tab = activeTab(state);
  if (!tab || tab.kind !== 'table' || !tab.tableSchema || !tab.tableName) return;
  const connId = state.activeConfig?.id;
  if (!connId) return;

  const resultCols = tab.queryResult?.columns ?? [];
  const widthsByName: Record<string, number> = {};
  for (const [idxStr, w] of Object.entries(tab.columnWidths)) {
    const idx = Number(idxStr);
    const name = resultCols[idx]?.name;
    if (name) widthsByName[name] = w;
  }

  const key = columnStateKey(connId, tab.tableSchema, tab.tableName);
  const entry = {
    widths: widthsByName,
    hidden: [...tab.hiddenColumns],
    sticky: [...tab.stickyColumns],
  };
  const hasAny =
    Object.keys(widthsByName).length > 0 || entry.hidden.length > 0 || entry.sticky.length > 0;

  const current = state.settings.tableColumnState ?? {};
  const next = { ...current };
  if (hasAny) {
    next[key] = entry;
  } else {
    delete next[key];
  }
  if (JSON.stringify(current) === JSON.stringify(next)) return;

  set((s) => ({ settings: { ...s.settings, tableColumnState: next } }));
  ipc.settings
    .set({ tableColumnState: next })
    .catch((err) => console.error('[plasma] persist tableColumnState failed', err));
}

/**
 * Apply persisted column state to a freshly created table tab BEFORE the
 * first data query runs. Widths get re-index-keyed against the real
 * table schema so the tab's in-memory shape matches what the query
 * will return. Returns a patch suitable for merging into a QueryTab.
 */
function loadTableColumnStateInto(
  state: SessionState,
  schemaName: string,
  tableName: string,
): Partial<QueryTab> {
  const connId = state.activeConfig?.id;
  if (!connId) return {};
  const key = columnStateKey(connId, schemaName, tableName);
  const entry = state.settings.tableColumnState?.[key];
  if (!entry) return {};

  // Walk the introspected columns to rebuild the index-keyed widths.
  const cols = state.schema ? columnsForTable(state.schema, schemaName, tableName) : [];
  const widthsByIdx: Record<number, number> = {};
  cols.forEach((name, i) => {
    const w = entry.widths[name];
    if (typeof w === 'number') widthsByIdx[i] = w;
  });

  return {
    columnWidths: widthsByIdx,
    hiddenColumns: new Set(entry.hidden),
    stickyColumns: new Set(entry.sticky),
  };
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
    queryErrorSql: null,
    sql, // store for display / copy
  });

  try {
    const result = await ipc.query.run(sql, params, { internal: true });
    patchTabById(set, tabId, {
      queryResult: result,
      queryRunState: 'idle',
      selectedCell: null,
      selectedRows: new Set(),
    });
  } catch (err) {
    patchTabById(set, tabId, {
      queryError: err instanceof Error ? err.message : String(err),
      queryErrorSql: sql,
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

  // Estimate path: no filters AND introspected reltuples is large. Skips
  // the seqscan that COUNT(*) would otherwise do on huge tables.
  const tableMeta = state.schema?.tables.find(
    (t) => t.schema === tab.tableSchema && t.name === tab.tableName,
  );
  const useEstimate =
    tab.filters.length === 0 &&
    tableMeta?.kind === 'table' &&
    typeof tableMeta.rowCountEstimate === 'number' &&
    tableMeta.rowCountEstimate >= ESTIMATED_COUNT_THRESHOLD;

  patchTabById(set, tabId, { countLoading: true });

  const { sql, params } = useEstimate
    ? buildEstimatedCountSql(tab.tableSchema, tab.tableName)
    : buildCountSql({
        schema: tab.tableSchema,
        table: tab.tableName,
        filters: tab.filters,
      });

  try {
    const result = await ipc.query.run(sql, params, { internal: true });
    const raw = result.rows[0]?.[0];
    const count = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number(raw);
    patchTabById(set, tabId, {
      totalRowCount: Number.isFinite(count) ? count : null,
      totalRowCountIsEstimate: useEstimate,
      countLoading: false,
    });
  } catch {
    patchTabById(set, tabId, { countLoading: false });
  }
}

async function runRlsCountForTab(
  set: (fn: (s: SessionState) => Partial<SessionState>) => void,
  get: () => SessionState,
  tabId: string,
) {
  const tab = get().tabs.find((t) => t.id === tabId);
  if (!tab || tab.kind !== 'table' || !tab.tableSchema || !tab.tableName) return;
  try {
    const { sql, params } = buildRlsCountSql(tab.tableSchema, tab.tableName);
    const res = await ipc.query.run(sql, params, { internal: true });
    const raw = res.rows[0]?.[0];
    const count = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number(raw);
    patchTabById(set, tabId, {
      rlsPolicyCount: Number.isFinite(count) ? count : 0,
    });
  } catch {
    // pg_policies may be unreadable for unprivileged roles — silently
    // leave rlsPolicyCount null. The badge will be hidden.
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
