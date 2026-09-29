import { ipc } from '@/lib/ipc';
import { type RunMode, resolveRunTarget, splitSqlStatements } from '@/lib/sql-split';
import {
  type Filter,
  type TableSort,
  buildCountSql,
  buildDataSql,
  buildEstimatedCountSql,
  buildRlsCountSql,
  buildRolesSql,
} from '@/lib/table-query';
import type {
  AiMessage,
  ConnectionConfig,
  ConnectionEngine,
  ConnectionRecovered,
  ConnectionSshConfig,
  HistoryEntry,
  HistoryListOpts,
  OsOverview,
  PgNotice,
  QueryResult,
  RedisBulkDeleteResult,
  RedisKeyMeta,
  RedisOverview,
  RedisScanResult,
  SavedConnection,
  SavedQuery,
  SchemaInfo,
  Settings,
  TxnState,
} from '@shared/protocol';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { unsupportedStatementReason } from '@/lib/sql-split';
import {
  duplicateTitle,
  installTabPersistence,
  isPreviewTab,
  isTabDirty,
  loadPersistedTabs,
  nextSqlTabTitle,
  restoreTabs,
} from './session-tabs';
import { useWorkbench } from './workbench';
import { errorText, freshSessionPatch, setRoleSql } from './session-connection';
import { looksDestructive, looksLikeDdl } from './session-sql-heuristics';
import { REDIS_INITIAL_STATE, createRedisActions, redisConnectReset } from './session-redis';
import {
  cancelProdGate as cancelProdGateAction,
  requestProdConfirm,
  settleExternalProdGate,
} from './session-prod-gate';
import {
  ensureAllSchemaColumns as ensureAllSchemaColumnsAction,
  ensureSchemaColumns as ensureSchemaColumnsAction,
  refreshSchemaCoalesced,
} from './session-schema';
import {
  type SavedQueryPatch,
  patchSavedQuery,
  replaceSavedQuery,
  savedQueryFromTab,
} from './session-saved-queries';
import {
  type PendingEditsError,
  commitPendingEdits as commitPendingEditsAction,
  discardPendingEdit as discardPendingEditAction,
  duplicateValues,
  queueCellEdit,
  queueInsert,
  queueRowDeletes,
  revertPendingEdits as revertPendingEditsAction,
  tablePkNames,
  updatePendingInsert as updatePendingInsertAction,
} from './session-pending-edits';

/**
 * When a table is unfiltered AND the introspected estimate is above this
 * threshold, we use pg_class.reltuples instead of COUNT(*). For small
 * tables COUNT(*) is cheap and accurate; for huge tables it can take
 * minutes.
 */
const ESTIMATED_COUNT_THRESHOLD = 1_000_000;

/** F11: streamed notices kept per tab run (the worker adds a "+N more" note). */
const MAX_TAB_NOTICES = 2_000;

/** F12: timeout for Plasma's own lookups on the side connection. */
const LOOKUP_TIMEOUT_MS = 15_000;

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
 *   - runQuery lives here; prod-gate helpers and the pending-edits tray
 *     live in sibling modules (session-prod-gate, session-pending-edits)
 *     that this file composes into the store.
 *   - `txnState` mirrors the primary connection's real transaction status,
 *     which the worker reads from the server after every statement (F4/F9).
 */


export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error';
export type QueryRunState = 'idle' | 'running';
/**
 * Tab kinds.
 *  - sql/table     → Postgres
 *  - redis-key     → key viewer (string/list/set/zset/hash/stream/json)
 *  - redis-cli     → free-form Redis command terminal
 *  - redis-pubsub  → live tail of one channel / pattern
 *  - redis-analyze → memory analyzer scan result
 *  - redis-slowlog → SLOWLOG GET viewer
 *  - os-search     → OpenSearch DSL editor + result grid (Discover)
 *  - os-index      → OpenSearch index detail (mapping + stats)
 *  - os-sql        → OpenSearch SQL plugin canvas
 *  - os-console    → OpenSearch Dev Tools console (raw REST, O14)
 */
export type TabKind =
  | 'sql'
  | 'table'
  | 'redis-key'
  | 'redis-cli'
  | 'redis-pubsub'
  | 'redis-analyze'
  | 'redis-slowlog'
  | 'redis-server'
  | 'os-search'
  | 'os-index'
  | 'os-sql'
  | 'os-console';
export type TableViewMode = 'data' | 'structure' | 'definition';
export type EntityKind =
  | 'table'
  | 'view'
  | 'matview'
  | 'foreign'
  | 'partitioned'
  | 'function'
  | 'procedure'
  | 'sequence'
  | 'type'
  | 'extension';
/** Drives what the main right-side canvas renders. Switched from IconRail. */
export type CanvasMode = 'database' | 'history' | 'settings' | 'monitor';
/** Which slot of the right rail is currently expanded. null = collapsed. */
export type RightPanelMode = 'details' | 'query' | 'role' | 'rls' | 'ai' | null;

/** One row in the AI chat transcript. Streamed assistant messages mutate
 *  in place as deltas arrive — keep them flat strings. */
export interface AiTurn extends AiMessage {
  id: string;
  /** True while a streamed assistant turn is still receiving deltas. */
  streaming?: boolean;
  /** Server-side error captured for this turn, if any. */
  error?: string;
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

/**
 * One queued, uncommitted cell edit. Buffered edits accumulate as the
 * user types in the grid; nothing hits the database until they click
 * "Commit (N)" in the tray. PK identification is captured at queue
 * time so a later refresh / sort doesn't break the WHERE clause.
 */
export interface PendingEdit {
  id: string;
  tabId: string;
  schema: string;
  table: string;
  /** 'update' (default when absent) · 'delete' · 'insert'. */
  kind?: 'update' | 'delete' | 'insert';
  /** ORIGINAL (server) primary-key values as Postgres text; {} for inserts. */
  pkValues: Record<string, unknown>;
  /** Stable row identity (rowKeyOf(pkValues)) — survives paging / sorting. */
  rowKey?: string;
  /** Updated column; '' for insert / delete. */
  column: string;
  oldValue: unknown;
  /** Postgres text for the new value; null = SQL NULL. */
  newValue: string | null;
  /** Insert only: column → Postgres text (null = NULL); omitted = DEFAULT. */
  values?: Record<string, string | null>;
  /** Visible row index at queue time, used for in-grid highlighting. */
  rowIndex: number;
  columnIndex: number;
  connectionGen?: number;
}

export interface QueryTab {
  [key: string]: any;
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
  /** Table tabs: 'data' = grid, 'structure' = columns/constraints/indexes, 'definition' = DDL. SQL tabs ignore. */
  viewMode: TableViewMode;
  /** RLS policy count for the table backing this tab. null = not yet loaded. */
  rlsPolicyCount: number | null;
  /** Saved query this tab was opened from / saved as — "Update" writes back to it (PC6). */
  savedQueryId?: string;

  // ── Redis tab fields (kind = 'redis-key' / 'redis-cli') ──
  /** Key currently being viewed in a redis-key tab. */
  redisKey?: string;
  /** Database the redis-key tab reads from (R5) — independent of the sidebar db. */
  redisDb?: number;
  /** Pub/sub channel/pattern for a redis-pubsub tab. */
  redisChannel?: string;
  redisPattern?: boolean;

  // ── OpenSearch tab fields (kind = 'os-search' / 'os-index' / 'os-sql') ──
  /** Index targeted by an os-search or os-index tab. */
  osIndex?: string;
  /** Cached DSL JSON body for an os-search tab. */
  osBody?: string;
  /** KQL/Lucene query string for the Discover canvas. */
  osQueryString?: string;
  /** Cached SQL text for an os-sql tab. */
  osSql?: string;
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
  geist: "'Geist Variable', 'Geist', ui-sans-serif, system-ui, -apple-system, sans-serif",
  inter: "'Inter Variable', 'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif",
  outfit: "'Outfit Variable', 'Outfit', ui-sans-serif, system-ui, -apple-system, sans-serif",
  'plus-jakarta': "'Plus Jakarta Sans Variable', 'Plus Jakarta Sans', ui-sans-serif, system-ui, -apple-system, sans-serif",
  'ibm-plex': "'IBM Plex Sans Variable', 'IBM Plex Sans', ui-sans-serif, system-ui, -apple-system, sans-serif",
  system:
    "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
};

const FONT_MONO_STACKS: Record<string, string> = {
  'jetbrains-mono': "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  'geist-mono': "'Geist Mono Variable', 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
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
  rightSidebarWidth: 300,
  editorExpanded: false,
  editorFontSize: 13,
  editorHeightPx: 280,
  defaultPageSize: 50,
  queryTimeoutMs: 0,
  restoreWorkspace: true,
  safeModeDefault: 'confirm-dangerous',
  connectionSafeMode: {},
  csvExport: { delimiter: ',', header: true, quote: '"', nullAs: 'empty', lineEnding: 'lf' },
  gridAlternatingRows: true,
  estimatedCountThreshold: 100_000,
  openrouterApiKey: '',
  openrouterModel: 'anthropic/claude-sonnet-4.5',
  claudeApiKey: '',
  transactionMode: false,
  autoConnectOnLaunch: true,
  autoReconnect: true,
  lastConnectionId: null,
  connectionTags: {},
  connectionSsh: {},
  schemaSnapshots: [],
  favoriteSchemas: {},
  favoriteTables: {},
  tableColumnState: {},
  savedQueries: {},
  windowBounds: null,
};

/** Fill any keys missing from a settings payload with renderer defaults. */
export function withDefaults(settings: Partial<Settings>): Settings {
  const merged = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
  for (const [k, v] of Object.entries(settings)) if (v !== undefined) merged[k] = v;
  return merged as Settings;
}

/** Persist the saved connection just opened, for auto-connect on launch. */
function rememberLastConnection(get: () => SessionState, id: string) {
  if (get().settings.lastConnectionId !== id) void get().updateSettings({ lastConnectionId: id });
}

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
    queryResults: [],
    activeResultIndex: 0,
    queryGeneration: 0,
    queryNotices: [],
    queryRunningRange: null,
    queryErrorRange: null,
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
    queryResults: [],
    activeResultIndex: 0,
    queryGeneration: 0,
    queryNotices: [],
    queryRunningRange: null,
    queryErrorRange: null,
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
  /** Last introspection failure, shown by the sidebar (PC8). */
  schemaError: string | null;
  /** Schemas whose columns + FKs are loaded into `schema` (lazy, F16). */
  columnSchemas: Set<string>;
  expandedSchemas: Set<string>;
  /** The last-opened table, used to highlight the current row in the sidebar. */
  activeTable: { schema: string; name: string } | null;

  // ── non-relational engine state ──
  /** Latest INFO snapshot for a connected Redis instance. */
  redisOverview: RedisOverview | null;
  /** Cached SCAN page used by the Redis sidebar key tree. */
  redisKeys: RedisScanResult | null;
  /** SCAN MATCH filter typed by the user; null = no filter. */
  redisMatch: string | null;
  redisLoading: boolean;
  /** Database the Redis sidebar browses (R20). */
  redisDb: number;
  /** Last Redis read error (scan / overview), shown in the sidebar (R7). */
  redisError: string | null;
  /** SCAN TYPE filter; null = all types (R30). */
  redisTypeFilter: string | null;
  /** A scan page is in flight. */
  redisScanning: boolean;
  /** Latest cluster + indices snapshot for a connected OpenSearch cluster. */
  osOverview: OsOverview | null;
  osLoading: boolean;
  /** True while the New Index dialog is mounted. */
  osNewIndexOpen: boolean;
  /** Index name pending delete-confirmation, or null when closed. */
  [key: string]: any;
  osDeleteIndexName: string | null;
  /** Last-opened resource per non-relational engine, used to highlight sidebar. */
  activeRedisKey: string | null;
  activeOsIndex: string | null;

  // ── Bulk-select (Redis sidebar) ──
  /** When true, the Redis sidebar shows checkboxes next to each key. */
  redisBulkMode: boolean;
  /** Keys currently checked in bulk mode. Cleared on disconnect / mode-off. */
  selectedRedisKeys: Set<string>;

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
  /** G2 / C15: why the last SET ROLE / RESET ROLE failed, or a role that was lost on reconnect. */
  roleError: string | null;

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

  // ── query history (cached copy for the history sheet / canvas) ──
  history: HistoryEntry[];
  /** Active server-side filters for history.list (U35). */
  historyFilter: HistoryListOpts;

  // ── AI chat (OpenRouter sidecar) ──
  aiChat: AiTurn[];
  aiPending: boolean;
  /** Active streaming request id, used to route deltas + cancel. */
  aiRequestId: string | null;
  /** Connection the current `aiChat` belongs to (G3: chat is per connection). */
  aiChatConnectionId: string | null;

  // ── Pending edits (buffered inline-edit tray) ──
  pendingEdits: PendingEdit[];
  pendingEditsBusy: boolean;
  /** Last commit failure: Postgres message + the edits whose statement failed. */
  pendingEditsError: PendingEditsError | null;

  /**
   * When the user fires a destructive query (DELETE/TRUNCATE/DROP/
   * UPDATE without WHERE) against a prod-tagged connection, runQuery
   * stashes the pending SQL here and renders a confirm dialog. The
   * user's choice resumes (or aborts) the run.
   */
  prodGate: {
    sql: string;
    tabId: string;
    connectionGen: number;
    /**
     * 'commitEdits' = the grid's pending-changes tray (resumes the commit).
     * 'external' = Notebook / Mock data / Explain waiting on `confirmUserSql`.
     */
    kind?: 'commitEdits' | 'external';
    summary?: string;
  } | null;

  // ── actions ──
  openDialog(prefill?: ConnectionConfig): void;
  closeDialog(): void;
  setPaletteOpen(open: boolean): void;
  togglePalette(): void;
  toggleEditMode(): void;
  setSettingsOpen(open: boolean): void;
  setHistoryOpen(open: boolean): void;
  requestDeleteConnection(id: string | null): void;

  /** `ssh`: the dialog's tunnel settings (null = no tunnel, omitted = the saved ones). */
  testConnection(
    config: ConnectionConfig,
    ssh?: ConnectionSshConfig | null,
  ): Promise<{ ok: boolean; message: string }>;
  connect(config: ConnectionConfig): Promise<void>;
  disconnect(): Promise<void>;
  /** Clear local connection state after an unexpected worker restart (U20). */
  handleWorkerReset(): void;
  /**
   * Adopt the session main re-established after a network/VPN drop (U27).
   * The generation changes, so in-flight results and pending edits from
   * the previous generation stop being committable by design.
   */
  handleConnectionRecovered(recovered: ConnectionRecovered): void;
  refreshSchema(): Promise<void>;
  /** Load columns for one schema on demand (no-op when already loaded). */
  ensureSchemaColumns(schemaName: string): Promise<void>;
  /** Load columns for every schema (whole-database views such as schema diff). */
  ensureAllSchemaColumns(): Promise<void>;
  toggleSchema(name: string): void;

  // ── Non-relational engine actions ──
  refreshRedisOverview(): Promise<void>;
  scanRedisKeys(opts?: { cursor?: string; match?: string }): Promise<void>;
  setRedisMatch(match: string | null): void;
  setRedisTypeFilter(type: string | null): void;
  setRedisDb(db: number): void;
  openRedisKey(key: string, db?: number): void;
  openRedisCli(): void;
  openRedisPubsub(channel: string, pattern: boolean): void;
  openRedisAnalyze(): void;
  openRedisSlowlog(): void;
  openRedisServer(): void;
  /** Rejects on failure (R7). */
  deleteRedisKey(key: string, db?: number): Promise<void>;
  /** Rejects on failure (R7). */
  setRedisTtl(
    key: string,
    seconds: number,
    opts?: { db?: number; mode?: 'expire' | 'pexpire' | 'expireat' | 'persist' },
  ): Promise<void>;
  redisKeysRemoved(keys: string[], db: number): void;
  redisKeyAdded(meta: RedisKeyMeta, db: number): void;
  redisKeyRenamed(from: string, to: string, db: number): void;

  // Bulk select
  toggleRedisBulkMode(): void;
  toggleRedisKeyChecked(key: string): void;
  clearRedisSelected(): void;
  /** Resolves with the per-key result; rejects when the request failed (R1/R7). */
  bulkDeleteSelectedRedisKeys(): Promise<RedisBulkDeleteResult>;

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

  // Per-tab actions operate on the active tab by default
  setSql(sql: string): void;
  /**
   * Execute SQL for the active tab.
   * - default / `{ all: false }`: selection if non-empty, else statement at cursor (U24)
   * - `{ all: true }`: whole buffer (⌘⇧⏎)
   * - `{ sql, base? }`: run this exact script (prod-gate resume); skips caret resolution
   */
  runQuery(opts?: { all?: boolean; mode?: RunMode; sql?: string; base?: number }): Promise<void>;
  /** Switch the grid to another statement result from the last multi-result run (U26). */
  setActiveResultIndex(index: number): void;
  /** ⌥← / ⌥→ — cycle the statement switcher. */
  cycleActiveResult(delta: -1 | 1): void;
  /** Append a streamed Postgres NOTICE to the origin tab of the in-flight run. */
  appendPgNotice(notice: PgNotice): void;
  cancelQuery(): Promise<void>;
  /**
   * Open a table tab. Single clicks open a reusable *preview* tab (italic)
   * that the next preview open replaces; `preview: false` pins it.
   */
  openTable(schema: string, table: string, opts?: { newTab?: boolean; preview?: boolean }): void;
  /**
   * `also` adds equality filters for the other columns of a composite
   * foreign key (F7); values there are Postgres text.
   */
  openForeignRow(
    refSchema: string,
    refTable: string,
    refColumn: string,
    value: unknown,
    also?: Array<{ column: string; value: string }>,
  ): void;
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
  /** Toggle pending deletion of rows (indices into the tab's result rows). */
  deleteRows(rowIndices: number[]): void;
  /** Queue an INSERT copying the row (PKs with defaults left to the server). */
  duplicateRow(rowIndex: number): void;
  updatePendingInsert(id: string, column: string, value: string | null): void;
  discardPendingEdit(id: string): void;

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
  openSqlInNewTab(sql: string, opts?: { title?: string; fileName?: string; clean?: boolean }): string;
  /** Mark a SQL tab's buffer as saved (file / snippet). */
  markTabClean(id: string, patch?: { title?: string; fileName?: string }): void;
  /** Close tabs immediately, no dirty check. */
  closeTabsNow(ids: string[]): void;
  /** Pending "close tabs with unsaved SQL?" confirmation (D1). */
  closeTabsRequest: { ids: string[]; dirtyTitles: string[] } | null;
  tabsConnectionId: string | null;

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

  // Saved queries (per active connection)
  saveCurrentTab(name: string): Promise<void>;
  deleteSavedQuery(id: string): Promise<void>;
  openSavedQuery(id: string): void;
  /** Rename / move to folder / (un)favourite a saved query. */
  updateSavedQuery(id: string, patch: SavedQueryPatch): Promise<void>;
  /** Overwrite saved query `id` with the active tab's current contents. */
  updateSavedQueryFromTab(id: string): Promise<void>;
  /** Save arbitrary SQL (e.g. a history entry) as a saved query. */
  saveSqlAsQuery(name: string, sql: string): Promise<void>;

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
  setRightSidebarWidth(width: number): void;

  // History
  loadHistory(opts?: HistoryListOpts): Promise<void>;
  setHistoryFilter(patch: Partial<HistoryListOpts>): void;
  clearHistory(): Promise<void>;
  reuseHistoryQuery(sql: string): void;
  /** Pin a history SQL string into saved queries (snippet). */
  saveHistoryAsSnippet(sql: string, name: string, connectionId?: string | null): Promise<void>;
  /** ⌘↑ in an empty editor — recall the previous statement for this connection. */
  recallPreviousHistory(): Promise<boolean>;

  // Transactions
  beginTxn(): Promise<void>;
  commitTxn(): Promise<void>;
  rollbackTxn(): Promise<void>;

  // AI
  aiAsk(prompt: string, opts?: { withSchema?: boolean }): Promise<void>;
  aiCancel(): Promise<void>;
  aiClear(): void;
  /** Apply a streamed delta event from the main process. */
  aiApplyEvent(
    evt:
      | { kind: 'delta'; requestId: string; text: string }
      | { kind: 'done'; requestId: string }
      | { kind: 'error'; requestId: string; message: string },
  ): void;

  // SQL formatting (calls main → sql-formatter → back). Replaces the
  // active tab's SQL on success; no-op for table tabs (their SQL is
  // compiled, not user-edited).
  formatActiveSql(): Promise<void>;

  // Pending edits (buffered inline-edit tray)
  commitPendingEdits(opts?: { confirmed?: boolean }): Promise<void>;
  revertPendingEdits(): Promise<void>;

  // Prod gate
  setConnectionTag(
    connectionId: string,
    tag: 'prod' | 'staging' | 'dev' | 'local' | null,
  ): Promise<void>;
  /** Resume a prod-gated runQuery after user confirms. */
  confirmProdGate(): void;
  cancelProdGate(): void;
  /**
   * Prod-gate check for user SQL run outside the editor (Notebook, Mock
   * data, Explain ANALYZE). Resolves true when it may run. `force` asks
   * even for non-destructive SQL (e.g. inserting mock rows).
   */
  confirmUserSql(sql: string, opts?: { force?: boolean; summary?: string }): Promise<boolean>;
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
  schemaError: null,
  columnSchemas: new Set<string>(),
  expandedSchemas: new Set(),
  activeTable: null,

  redisOverview: null,
  redisKeys: null,
  redisMatch: null,
  redisLoading: false,
  ...REDIS_INITIAL_STATE,
  osOverview: null,
  osLoading: false,
  osNewIndexOpen: false,
  osDeleteIndexName: null,
  activeRedisKey: null,
  activeOsIndex: null,
  redisBulkMode: false,
  selectedRedisKeys: new Set<string>(),

  tabs: [initialTab],
  /** Connection the open tabs belong to (restore / persistence key, D1). */
  tabsConnectionId: null,
  closeTabsRequest: null,
  activeTabId: initialTab.id,

  canvasMode: 'database',
  currentSchema: null,
  entityFilter: new Set<EntityKind>([
    'table',
    'view',
    'matview',
    'foreign',
    'partitioned',
    'function',
    'procedure',
    'sequence',
    'type',
    'extension',
  ]),

  activeRole: null,
  roleError: null,
  connectionGen: 0,
  connectionActionGate: null,
  availableRoles: [],

  rightPanelMode: 'details',

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
  historyFilter: { status: 'all', duration: 'all' },

  aiChat: [],
  aiPending: false,
  aiRequestId: null,
  aiChatConnectionId: null,

  pendingEdits: [],
  pendingEditsBusy: false,
  pendingEditsError: null,

  prodGate: null,

  // ── dialog / palette / settings toggles ──

  openDialog: (prefill) => set({ dialogOpen: true, dialogPrefill: prefill ?? null }),
  closeDialog: () => set({ dialogOpen: false, dialogPrefill: null }),

  setPaletteOpen: (open) => set({ paletteOpen: open }),
  togglePalette: () => set({ paletteOpen: !get().paletteOpen }),

  toggleEditMode: () => set({ editMode: !get().editMode }),

  // D2: Settings and History each have one surface — the full-page
  // canvas. These legacy entry points (palette, menu, ⌘H) route there.
  setSettingsOpen: (open) => {
    if (open) get().setCanvasMode('settings');
    else if (get().canvasMode === 'settings') get().setCanvasMode('database');
  },
  setHistoryOpen: (open) => {
    if (open && get().connectionState === 'connected') get().setCanvasMode('history');
    else if (get().canvasMode === 'history') get().setCanvasMode('database');
  },

  requestDeleteConnection: (id) => set({ deleteConfirmConnectionId: id }),

  // ── connection ──

  async testConnection(config, ssh) {
    try {
      const res = await ipc.conn.test(config, ssh);
      if (res.ok) {
        return { ok: true, message: `Connected · ${shortVersion(res.serverVersion)}` };
      }
      return { ok: false, message: res.message };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  },

  async connect(config) {
    if (get().pendingEdits.length > 0) { set({ connectionActionGate: { kind: 'connect', config } }); return; }
    // C12: one connect at a time — a second click or the reconnect timer
    // must not race the attempt already in flight.
    if (get().connectionState === 'connecting') return;
    set({ connectionState: 'connecting', connectionError: null });
    try {
      const { serverVersion, engine, connectionGen } = await ipc.conn.connect(config);
      const eff = (engine ?? config.engine ?? 'postgres') as ConnectionEngine;
      // B2: a new server session — nothing from the previous one survives.
      set(freshSessionPatch());
      clearSessionScopedTabState(set, get);
      set({
        // R2/R20: edit mode never carries over; Redis starts on the configured db.
        ...redisConnectReset({ ...config, engine: eff }),
        // Never keep the password in renderer state (C17); main holds it.
        activeConfig: { ...config, engine: eff, password: '' },
        serverVersion,
        connectionGen: connectionGen ?? get().connectionGen + 1,
        connectionState: 'connected',
        dialogOpen: false,
        dialogPrefill: null,
        activeTable: null,
        txnState: 'none',
        // Stale per-engine state from a prior connection.
        redisOverview: null,
        redisKeys: null,
        redisMatch: null,
        osOverview: null,
        activeRedisKey: null,
        activeOsIndex: null,
      });
      await get().loadSavedConnections();
      if (config.id && get().savedConnections.some((c) => c.id === config.id)) {
        rememberLastConnection(get, config.id);
      }
      await loadEngineOverview(set, get, eff);
      adoptConnectionTabs(set, get, eff);
      if (eff === 'postgres') void get().loadAvailableRoles();
    } catch (err) {
      // C21: main dropped the old session before dialling (the worker tore
      // it down), so the UI must stop showing it as live.
      set({
        ...freshSessionPatch(),
        activeConfig: null,
        serverVersion: null,
        connectionGen: 0,
        connectionState: 'error',
        connectionError: err instanceof Error ? err.message : String(err),
      });
      clearSessionScopedTabState(set, get);
    }
  },

  async connectSaved(id) {
    if (get().pendingEdits.length > 0) { set({ connectionActionGate: { kind: 'connectSaved', id } }); return; }
    if (get().connectionState === 'connecting') return; // C12
    set({ connectionState: 'connecting', connectionError: null });
    try {
      const { info, config } = await ipc.vault.connectById(id);
      const eff = (info.engine ?? config.engine ?? 'postgres') as ConnectionEngine;
      set(freshSessionPatch()); // B2
      clearSessionScopedTabState(set, get);
      set({
        // R2/R20: edit mode never carries over; Redis starts on the configured db.
        ...redisConnectReset({ ...config, engine: eff }),
        activeConfig: { ...config, engine: eff, password: '' },
        serverVersion: info.serverVersion,
        connectionGen: info.connectionGen ?? get().connectionGen + 1,
        connectionState: 'connected',
        dialogOpen: false,
        dialogPrefill: null,
        activeTable: null,
        txnState: 'none',
        redisOverview: null,
        redisKeys: null,
        redisMatch: null,
        osOverview: null,
        activeRedisKey: null,
        activeOsIndex: null,
      });
      rememberLastConnection(get, id);
      await loadEngineOverview(set, get, eff);
      adoptConnectionTabs(set, get, eff);
      if (eff === 'postgres') void get().loadAvailableRoles();
    } catch (err) {
      // C21: main dropped the old session before dialling (the worker tore
      // it down), so the UI must stop showing it as live.
      set({
        ...freshSessionPatch(),
        activeConfig: null,
        serverVersion: null,
        connectionGen: 0,
        connectionState: 'error',
        connectionError: err instanceof Error ? err.message : String(err),
      });
      clearSessionScopedTabState(set, get);
    }
  },

  async disconnect() {
    if (get().pendingEdits.length > 0) { set({ connectionActionGate: { kind: 'disconnect' } }); return; }
    // A deliberate disconnect must not be undone by auto-connect on relaunch.
    if (get().settings.lastConnectionId) void get().updateSettings({ lastConnectionId: null });
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
        connectionGen: 0,
        currentSchema: null,
        availableRoles: [],
        activeRole: null,
        roleError: null,
        redisOverview: null,
        redisKeys: null,
        redisMatch: null,
        osOverview: null,
        activeRedisKey: null,
        activeOsIndex: null,
        redisBulkMode: false,
        selectedRedisKeys: new Set<string>(),
      });
      // Clear all tabs' results since they reference a now-dead connection
      set((state) => ({
        tabs: state.tabs.map((t) => ({
          ...t,
          queryResult: null,
          queryResults: [],
          activeResultIndex: 0,
          queryNotices: [],
          queryError: null,
          page: 0,
          sortColumn: null,
          selectedCell: null,
          selectedRows: new Set(),
        })),
      }));
    }
  },

  handleWorkerReset() {
    set({
      activeConfig: null,
      serverVersion: null,
      connectionState: 'idle',
      connectionError: null,
      schema: null,
      expandedSchemas: new Set(),
      activeTable: null,
      txnState: 'none',
      currentSchema: null,
      availableRoles: [],
      activeRole: null,
      roleError: null,
      redisOverview: null,
      redisKeys: null,
      redisMatch: null,
      osOverview: null,
      activeRedisKey: null,
      activeOsIndex: null,
      redisBulkMode: false,
      selectedRedisKeys: new Set<string>(),
    });
    // Clear all tabs' results since they reference a now-dead connection
    set((state) => ({
      tabs: state.tabs.map((t) => ({
        ...t,
        queryResult: null,
        queryError: null,
        queryRunState: 'idle' as const,
        queryResults: [],
        activeResultIndex: 0,
        queryNotices: [],
        queryRunningRange: null,
        queryErrorRange: null,
        page: 0,
        sortColumn: null,
        selectedCell: null,
        selectedRows: new Set(),
      })),
    }));
  },

  handleConnectionRecovered(recovered) {
    // C11: a recovery for a connection the user already left is stale.
    const active = get().activeConfig;
    if (recovered.connectionId && active && active.id !== recovered.connectionId) return;
    if (!active && recovered.connectionId) return;
    // Main reconnected for us, so the app is genuinely connected again —
    // but on a brand-new server session: no open transaction, and a new
    // generation that in-flight results and staged edits are checked
    // against (U01/U27). Pending edits are deliberately kept so the user
    // decides whether to discard them; the write gate refuses them.
    const lostRole = get().activeRole;
    set({
      connectionState: 'connected',
      connectionError: null,
      serverVersion: recovered.serverVersion,
      connectionGen: recovered.connectionGen,
      txnState: 'none',
    });
    // C15: SET ROLE lived on the old server session. Re-apply it so the UI
    // never shows a role the queries aren't running as; if that fails,
    // clear it and say so.
    if (lostRole) {
      void ipc.query
        .run(setRoleSql(lostRole), undefined, { internal: true })
        .then(() => set({ roleError: null }))
        .catch((err: unknown) => {
          set({
            activeRole: null,
            roleError: `Reconnected as the login role — SET ROLE ${lostRole} could not be restored: ${errorText(err)}`,
          });
        });
    }
  },

  async refreshSchema() {
    // Coalesced + incremental: objects for the whole database, columns
    // only for schemas already loaded (see session-schema.ts).
    await refreshSchemaCoalesced(set, get);
  },

  ensureSchemaColumns(schemaName) {
    return ensureSchemaColumnsAction(set, get, schemaName);
  },

  ensureAllSchemaColumns() {
    return ensureAllSchemaColumnsAction(set, get);
  },

  toggleSchema(name) {
    const next = new Set(get().expandedSchemas);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    set({ expandedSchemas: next });
  },

  // ── Redis ── (session-redis.ts)
  ...createRedisActions(set, get, createEmptyTab),

  // ── OpenSearch ──

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

  // ── per-tab actions ──

  setSql(sql) {
    patchActiveTab(set, get, { sql });
  },

  async runQuery(opts?: { all?: boolean; mode?: RunMode; sql?: string; base?: number }) {
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

    // U24: ⌘⏎ = selection else statement-at-cursor; ⌘⇧⏎ = whole buffer.
    // Menu Run without an editor caret falls back to the whole buffer.
    // Prod-gate confirm passes `{ sql }` so the approved payload runs once.
    let script: string;
    let base: number;
    if (opts?.sql != null) {
      script = opts.sql;
      base = opts.base ?? 0;
      if (script.trim().length === 0) return;
    } else {
      const mode: RunMode = opts?.mode ?? (opts?.all ? 'buffer' : 'smart');
      // Only trust this tab's caret, and only if it was read from the
      // current text — otherwise its offsets point into different SQL.
      const saved = useWorkbench.getState().carets[tab.id];
      const caret = saved && saved.bufferLength === tab.sql.length ? saved : null;
      const target = resolveRunTarget(tab.sql, mode, caret);
      if (!target) return;
      script = target.sql;
      base = target.base;
    }

    // Prod gate: if active connection is tagged 'prod' and the script
    // includes any destructive statement, stash the SQL and prompt for
    // confirmation. The user resumes via `confirmProdGate()` with `{ sql }`,
    // which skips this check so the approved payload executes once.
    if (opts?.sql == null) {
      const connId = state.activeConfig?.id;
      const tag = connId ? state.settings.connectionTags?.[connId] : undefined;
      if (tag === 'prod' && state.prodGate === null) {
        const stmts = splitSqlStatements(script);
        if (stmts.some((s) => looksDestructive(s.text))) {
          set({ prodGate: { sql: script, tabId: tab.id, connectionGen: state.connectionGen ?? 0 } });
          return;
        }
      }
    }

    // U03/U26: capture origin tab + generation before any await so results /
    // errors / notices publish only to that tab (not whichever is active later).
    const originTabId = tab.id;
    const originConnGen = state.connectionGen ?? 0;
    const generation = (tab.queryGeneration ?? 0) + 1;
    patchTabById(set, originTabId, {
      queryRunState: 'running',
      queryError: null,
      queryErrorSql: null,
      queryErrorRange: null,
      queryRunningRange: null,
      queryGeneration: generation,
      runStartedAt: Date.now(),
      queryResults: [],
      activeResultIndex: 0,
      queryResult: null,
      queryNotices: [],
    });

    const publishOrigin = (patch: Partial<QueryTab>) => {
      const current = get().tabs.find((t) => t.id === originTabId);
      if (!current || current.queryGeneration !== generation) return;
      if ((get().connectionGen ?? 0) !== originConnGen) { patchTabById(set, originTabId, { queryRunState: 'idle', queryError: 'connection changed while query was running — result discarded' }); return; }
      patchTabById(set, originTabId, patch);
    };

    // Multi-statement scripts: split with a quote/comment-aware tokenizer
    // and run each separately. Collect every QueryResult for the statement
    // switcher / messages strip (U26). Failures stop execution and surface
    // "stopped at N of M". Offsets remap into the full tab buffer for Monaco.
    const statements = splitSqlStatements(script).map((s) => ({
      text: s.text,
      start: base + s.start,
      end: base + s.end,
    }));
    try {
      const results: QueryResult[] = [];
      let anyDdl = false;
      for (let i = 0; i < statements.length; i++) {
        const stmt = statements[i]!;
        publishOrigin({
          queryRunningRange: { start: stmt.start, end: stmt.end },
        });
        try {
          // Editor row limit (TablePlus "No limit" menu) — enforced in the
          // worker's cursor read, so the SQL itself is never rewritten.
          const rowLimit = useWorkbench.getState().rowLimit;
          const unsupported = unsupportedStatementReason(stmt.text);
          if (unsupported) throw new Error(unsupported);
          const result =
            rowLimit === null
              ? await ipc.query.run(stmt.text)
              : await ipc.query.run(stmt.text, undefined, { maxRows: rowLimit });
          // Attach any streamed notices that arrived for this statement
          // index (driver also returns notices; merge uniquely by message).
          const current = get().tabs.find((t) => t.id === originTabId);
          const streamed = ((current?.queryNotices ?? []) as Array<{ statementIndex: number; notice: PgNotice }>)
            .filter((n) => n.statementIndex === i)
            .map((n) => n.notice);
          const merged = mergeNotices(result.notices, streamed);
          results.push(
            merged.length > 0
              ? { ...result, notices: merged, sql: stmt.text }
              : { ...result, sql: stmt.text },
          );
          // F4/F9: the worker reports the server's real transaction status.
          if (result.txnState && (get().connectionGen ?? 0) === originConnGen) {
            set({ txnState: result.txnState });
          }
          // Progressive reveal: keep the latest result visible while the rest run.
          publishOrigin({
            ...resultPatch(results, defaultActiveResultIndex(results)),
            page: 0,
            sortColumn: null,
            selectedCell: null,
            selectedRows: new Set(),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const tag = statements.length > 1 ? ` (statement ${i + 1} of ${statements.length})` : '';
          // An error inside a transaction block aborts it (E). With
          // Transaction mode on, the worker had BEGUN before the statement.
          if (
            (get().connectionGen ?? 0) === originConnGen &&
            (get().txnState === 'active' || get().settings.transactionMode)
          ) {
            set({ txnState: 'error' });
          }
          publishOrigin({
            ...resultPatch(results, defaultActiveResultIndex(results)),
            queryError: `${message}${tag}`,
            queryErrorSql: stmt.text,
            queryErrorRange: { start: stmt.start, end: stmt.end },
            queryRunningRange: null,
            queryRunState: 'idle',
          });
          if (anyDdl) void get().refreshSchema();
          return;
        }
        if (looksLikeDdl(stmt.text)) anyDdl = true;
      }
      publishOrigin({
        ...resultPatch(results, defaultActiveResultIndex(results)),
        queryRunState: 'idle',
        queryRunningRange: null,
        page: 0,
        sortColumn: null,
        selectedCell: null,
        selectedRows: new Set(),
      });
      if (anyDdl) {
        void get().refreshSchema();
      }
    } catch (err) {
      publishOrigin({
        queryError: err instanceof Error ? err.message : String(err),
        queryErrorSql: script,
        queryErrorRange:
          statements.length > 0
            ? { start: statements[0]!.start, end: statements[statements.length - 1]!.end }
            : null,
        queryRunningRange: null,
        queryRunState: 'idle',
      });
    }
  },

  setActiveResultIndex(index) {
    const tab = activeTab(get());
    if (!tab || tab.queryResults.length === 0) return;
    const clamped = Math.max(0, Math.min(index, tab.queryResults.length - 1));
    if (clamped === tab.activeResultIndex) return;
    patchActiveTab(set, get, {
      ...resultPatch(tab.queryResults, clamped),
      page: 0,
      sortColumn: null,
      selectedCell: null,
      selectedRows: new Set(),
    });
  },

  cycleActiveResult(delta) {
    const tab = activeTab(get());
    if (!tab || tab.queryResults.length <= 1) return;
    const next =
      (tab.activeResultIndex + delta + tab.queryResults.length) % tab.queryResults.length;
    get().setActiveResultIndex(next);
  },

  appendPgNotice(notice) {
    // Attach to the tab that is currently running a SQL script. Prefer a
    // running tab over the active one so a focus change mid-run still lands
    // notices on the origin (U03 + U26).
    const state = get();
    const running =
      state.tabs.find((t) => t.queryRunState === 'running' && t.kind === 'sql') ??
      activeTab(state);
    if (!running || running.kind !== 'sql') return;
    // F11: the worker caps notices per statement too; this bounds the
    // renderer's copy-on-append so a NOTICE flood can't freeze the UI.
    if (running.queryNotices.length >= MAX_TAB_NOTICES) return;
    const statementIndex = running.queryResults.length; // next / in-flight index
    patchTabById(set, running.id, {
      queryNotices: [...running.queryNotices, { statementIndex, notice }],
    });
  },

  async cancelQuery() {
    try {
      await ipc.query.cancel();
    } catch (err) {
      console.error('[plasma] cancel failed', err);
    }
  },

  openTable(schemaName, tableName, opts) {
    const state = get();
    void get().ensureSchemaColumns(schemaName);
    // Reuse an existing table tab for the same schema+table
    const existing = opts?.newTab
      ? undefined
      : state.tabs.find(
          (t) => t.kind === 'table' && t.tableSchema === schemaName && t.tableName === tableName,
        );
    const preview = opts?.preview ?? !opts?.newTab;
    if (existing) {
      set({
        activeTabId: existing.id,
        activeTable: { schema: schemaName, name: tableName },
        ...(preview || !existing.preview
          ? {}
          : { tabs: state.tabs.map((t) => (t.id === existing.id ? { ...t, preview: false } : t)) }),
      });
      return;
    }
    // Create a fresh table tab, then layer any persisted column state
    // (widths / hidden / sticky) ON TOP before kicking off the query —
    // hiddenColumns in particular has to be set before the SELECT is
    // compiled so the server doesn't return columns we're about to hide.
    const baseTab = createTableTab(state.settings.defaultPageSize, schemaName, tableName);
    const persistedPatch = loadTableColumnStateInto(state, schemaName, tableName);
    const tab: QueryTab = { ...baseTab, ...persistedPatch, preview };
    // A single-click open replaces the current untouched preview tab in
    // place (TablePlus / VS Code preview tabs, VF17).
    const editedTabs = new Set(state.pendingEdits.map((e) => e.tabId));
    const previewIdx =
      preview && !opts?.newTab ? state.tabs.findIndex((t) => isPreviewTab(t, editedTabs)) : -1;
    const nextTabs =
      previewIdx === -1
        ? [...state.tabs, tab]
        : state.tabs.map((t, i) => (i === previewIdx ? tab : t));
    set({
      tabs: nextTabs,
      activeTabId: tab.id,
      activeTable: { schema: schemaName, name: tableName },
    });
    void runTableDataQuery(set, get, tab.id);
    void runTableCountQuery(set, get, tab.id);
    void runRlsCountForTab(set, get, tab.id);
  },

  openForeignRow(refSchema, refTable, refColumn, value, also) {
    // FK click-through: open the referenced table as a fresh table tab
    // with an equality filter on the referenced column pre-applied. We
    // always create a new tab so prior FK navigations stay inspectable.
    if (value === null || value === undefined) return;
    const state = get();
    void get().ensureSchemaColumns(refSchema);
    const baseTab = createTableTab(state.settings.defaultPageSize, refSchema, refTable);
    const persistedPatch = loadTableColumnStateInto(state, refSchema, refTable);
    const fkId = () => `fk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const filter: Filter = {
      id: fkId(),
      column: refColumn,
      op: '=',
      value: value instanceof Date ? value.toISOString() : String(value),
    };
    const extra: Filter[] = (also ?? []).map((p) => ({ id: fkId(), column: p.column, op: '=', value: p.value }));
    const tab: QueryTab = { ...baseTab, ...persistedPatch, filters: [filter, ...extra] };
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
    if (!Number.isFinite(width)) return;
    const clamped = Math.max(200, Math.min(520, Math.round(width)));
    set({ settings: { ...get().settings, sidebarWidth: clamped } });
  },

  setRightSidebarWidth(width) {
    // Same contract as setSidebarWidth: optimistic here, persisted on drop.
    if (!Number.isFinite(width)) return;
    const clamped = Math.max(240, Math.min(720, Math.round(width)));
    set({ settings: { ...get().settings, rightSidebarWidth: clamped } });
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
    // Buffered edits: every cell change is queued in `pendingEdits` as an
    // overlay (server rows stay untouched — see session-pending-edits.ts).
    // Nothing reaches the database until the tray is committed. No-op
    // edits are dropped; `null` means SQL NULL, never ''.
    queueCellEdit(set, get, rowIndex, columnIndex, newValue);
  },

  async insertRow(values) {
    const state = get();
    const tab = activeTab(state);
    if (!tab || tab.kind !== 'table' || !tab.tableSchema || !tab.tableName) return;

    // Drop empty strings on columns with defaults — let Postgres apply them.
    const cols = columnMetaFor(state.schema, tab.tableSchema, tab.tableName);
    const toInsert: Record<string, string | null> = {};
    for (const c of cols) {
      const raw = values[c.name];
      if (raw === undefined) continue;
      if (raw === '' && c.hasDefault) continue;
      toInsert[c.name] = raw === '' && c.isNullable ? null : raw;
    }
    // Queued with the rest of the tray (A5): committed in one batch
    // through the prod-tag confirmation.
    queueInsert(set, get, toInsert);
  },

  async deleteRow(rowIndex) {
    queueRowDeletes(set, get, [rowIndex]);
  },

  deleteRows(rowIndices) {
    queueRowDeletes(set, get, rowIndices);
  },

  duplicateRow(rowIndex) {
    const state = get();
    const tab = activeTab(state);
    if (!tab || tab.kind !== 'table' || !tab.tableSchema || !tab.tableName || !tab.queryResult) return;
    const row = tab.queryResult.rows[rowIndex];
    if (!row) return;
    const cols = columnMetaFor(state.schema, tab.tableSchema, tab.tableName);
    queueInsert(set, get, duplicateValues(tab.queryResult.columns, row, cols));
  },

  updatePendingInsert(id, column, value) {
    updatePendingInsertAction(set, get, id, column, value);
  },

  discardPendingEdit(id) {
    discardPendingEditAction(set, get, id);
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
    if (state.tabs.some((t) => drop.has(t.id) && t.kind === 'sql' && t.queryRunState === 'running')) {
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
      set({ tabs: [fresh], activeTabId: fresh.id, closeTabsRequest: null });
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
    set({ tabs: remaining, activeTabId: nextActive });
  },

  requestCloseTabs(ids) {
    const state = get();
    const dirty = state.tabs.filter((t) => ids.includes(t.id) && isTabDirty(t));
    if (dirty.length === 0) {
      get().closeTabsNow(ids);
      return;
    }
    set({ closeTabsRequest: { ids, dirtyTitles: dirty.map((t) => t.title) } });
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
    get().requestCloseTabs(get().tabs.filter((t) => t.id !== id).map((t) => t.id));
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
      void runTableDataQuery(set, get, copy.id);
      void runTableCountQuery(set, get, copy.id);
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
      void runTableDataQuery(set, get, id);
      void runTableCountQuery(set, get, id);
    }
  },

  renameActiveTab(title) {
    get().renameTab(get().activeTabId, title);
  },

  // ── canvas mode + entity filtering ──

  setCanvasMode(mode) {
    set({ canvasMode: mode });
    if (mode === 'history') {
      void get().loadHistory();
    }
  },

  setCurrentSchema(name) {
    set({ currentSchema: name });
    if (name) void get().ensureSchemaColumns(name);
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
      const res = await ipc.query.sideband(sql, params, { timeoutMs: LOOKUP_TIMEOUT_MS });
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
        await ipc.query.run(setRoleSql(role), undefined, { internal: true });
      }
      set({ activeRole: role, roleError: null });
      // Re-run the active table tab so the new role's RLS policies apply.
      const tab = activeTab(get());
      if (tab?.kind === 'table') {
        void runTableDataQuery(set, get, tab.id);
        void runTableCountQuery(set, get, tab.id);
      }
    } catch (err) {
      // G2: say why instead of failing silently.
      console.error('[plasma] setActiveRole failed', err);
      set({ roleError: errorText(err) });
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
    // ⌘J: SQL tabs show / hide the inline editor (results take the room);
    // table tabs toggle the compiled-SQL pane of the right sidebar.
    const tab = activeTab(get());
    if (tab?.kind === 'table') {
      set({ rightPanelMode: get().rightPanelMode === 'query' ? 'details' : 'query' });
      return;
    }
    const wb = useWorkbench.getState();
    if (wb.editorHidden) wb.showEditor();
    else wb.setEditorHidden(true);
  },

  setEditorExpanded(expanded) {
    // "Open the editor" = show + focus the inline editor of a SQL tab
    // (a new one when a table tab is active). Never touches the sidebar.
    if (!expanded) {
      useWorkbench.getState().setEditorHidden(true);
      return;
    }
    if (activeTab(get())?.kind !== 'sql') get().addTab();
    set({ canvasMode: 'database' });
    useWorkbench.getState().showEditor();
  },

  setRightPanelMode(mode) {
    set({ rightPanelMode: mode });
  },

  // ── saved queries ──

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
    try {
      await ipc.settings.set({ savedQueries: nextMap });
    } catch (err) {
      console.error('[plasma] persist savedQueries failed', err);
    }
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
      tabs: get().tabs.map((t) => (t.id === tab.id ? { ...t, savedQueryId: id, cleanSql: t.sql } : t)),
    });
    try {
      await ipc.settings.set({ savedQueries: nextMap });
    } catch (err) {
      console.error('[plasma] persist savedQueries failed', err);
    }
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
    try {
      await ipc.settings.set({ savedQueries: nextMap });
    } catch (err) {
      console.error('[plasma] persist savedQueries failed', err);
    }
  },

  async saveSqlAsQuery(name, sql) {
    const state = get();
    const connId = state.activeConfig?.id;
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
    try {
      await ipc.settings.set({ savedQueries: nextMap });
    } catch (err) {
      console.error('[plasma] persist savedQueries failed', err);
    }
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
    try {
      await ipc.settings.set({ savedQueries: nextMap });
    } catch (err) {
      console.error('[plasma] persist savedQueries failed', err);
    }
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
    void runTableDataQuery(set, get, tab.id);
    void runTableCountQuery(set, get, tab.id);
    void runRlsCountForTab(set, get, tab.id);
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
      // Merge over renderer defaults: a main process built before a
      // setting existed (e.g. `pnpm dev` hot-reloads the renderer but not
      // main) returns objects without the new keys, and undefined widths /
      // flags would silently break the features that read them.
      const settings = withDefaults(await ipc.settings.get());
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
      const next = withDefaults(await ipc.settings.set(patch));
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

    try {
      const history = await ipc.history.list({
        limit: merged.limit,
        connectionId,
        search,
        status,
        duration,
      });
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

  reuseHistoryQuery(sql) {
    // E1: history always opens in a new SQL tab on the database canvas —
    // it never overwrites the active tab or closes the right sidebar.
    get().openSqlInNewTab(sql);
  },

  async saveHistoryAsSnippet(sql, name, connectionId) {
    const state = get();
    const connId = connectionId || state.activeConfig?.id;
    if (!connId) return;
    const trimmed = name.trim();
    if (!trimmed || !sql.trim()) return;
    const now = Date.now();
    const entry = {
      kind: 'sql' as const,
      id: freshId(),
      name: trimmed,
      createdAt: now,
      updatedAt: now,
      sql,
      pageSize: state.settings.defaultPageSize,
    };
    const current = state.settings.savedQueries ?? {};
    const list = current[connId] ?? [];
    const nextMap = { ...current, [connId]: [entry, ...list] };
    set({ settings: { ...state.settings, savedQueries: nextMap } });
    try {
      await ipc.settings.set({ savedQueries: nextMap });
    } catch (err) {
      console.error('[plasma] saveHistoryAsSnippet failed', err);
    }
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

  // ── AI ──

  async aiAsk(prompt, opts) {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    const state = get();
    if (state.aiPending) return; // single-flight per chat
    // G3: a different connection starts a fresh conversation.
    const connectionId = state.activeConfig?.id ?? null;
    const history = state.aiChatConnectionId === connectionId ? state.aiChat : [];

    const userTurn: AiTurn = {
      id: freshId(),
      role: 'user',
      content: trimmed,
    };
    const placeholder: AiTurn = {
      id: freshId(),
      role: 'assistant',
      content: '',
      streaming: true,
    };
    const requestId = freshId();
    set({
      aiChat: [...history, userTurn, placeholder],
      aiChatConnectionId: connectionId,
      aiPending: true,
      aiRequestId: requestId,
      rightPanelMode: 'ai',
    });

    // Strip Plasma-only fields before sending — main only needs role +
    // content per OpenAI/OpenRouter chat shape.
    const messages: AiMessage[] = [...history, userTurn].map((t) => ({
      role: t.role,
      content: t.content,
    }));

    const engine = state.activeConfig?.engine ?? 'postgres';
    const engineContext = buildEngineContext(state);

    try {
      const res = await ipc.ai.chat({
        requestId,
        messages,
        engine,
        engineContext,
        schema:
          engine === 'postgres'
            ? opts?.withSchema === false
              ? null
              : (state.schema ?? null)
            : null,
        model: state.settings.openrouterModel || undefined,
      });
      if (!res.accepted) {
        set((s) => ({
          aiChat: s.aiChat.map((t) =>
            t.id === placeholder.id ? { ...t, streaming: false, error: 'request rejected' } : t,
          ),
          aiPending: false,
          aiRequestId: null,
        }));
      }
    } catch (err) {
      set((s) => ({
        aiChat: s.aiChat.map((t) =>
          t.id === placeholder.id
            ? {
                ...t,
                streaming: false,
                error: err instanceof Error ? err.message : String(err),
              }
            : t,
        ),
        aiPending: false,
        aiRequestId: null,
      }));
    }
  },

  async aiCancel() {
    const id = get().aiRequestId;
    if (!id) return;
    try {
      await ipc.ai.cancel(id);
    } finally {
      set((s) => ({
        aiPending: false,
        aiRequestId: null,
        aiChat: s.aiChat.map((t) => (t.streaming ? { ...t, streaming: false } : t)),
      }));
    }
  },

  aiClear() {
    void get().aiCancel();
    set({ aiChat: [] });
  },

  aiApplyEvent(evt) {
    const state = get();
    if (state.aiRequestId !== evt.requestId) return; // stale stream
    if (evt.kind === 'delta') {
      // Append delta to the last assistant turn (streaming placeholder).
      const idx = [...state.aiChat]
        .reverse()
        .findIndex((t) => t.streaming && t.role === 'assistant');
      if (idx === -1) return;
      const realIdx = state.aiChat.length - 1 - idx;
      set({
        aiChat: state.aiChat.map((t, i) =>
          i === realIdx ? { ...t, content: t.content + evt.text } : t,
        ),
      });
      return;
    }
    if (evt.kind === 'done') {
      set({
        aiPending: false,
        aiRequestId: null,
        aiChat: state.aiChat.map((t) => (t.streaming ? { ...t, streaming: false } : t)),
      });
      return;
    }
    if (evt.kind === 'error') {
      set({
        aiPending: false,
        aiRequestId: null,
        aiChat: state.aiChat.map((t) =>
          t.streaming ? { ...t, streaming: false, error: evt.message } : t,
        ),
      });
    }
  },

  // ── Pending edits (buffered inline-edit tray) ──
  // Ownership: session-pending-edits.ts (U39)

  async commitPendingEdits(opts) {
    await commitPendingEditsAction(set, get, { runTableDataQuery, runTableCountQuery }, opts);
  },

  async revertPendingEdits() {
    await revertPendingEditsAction(set, get, { runTableDataQuery });
  },

  // ── Prod gate ──

  async setConnectionTag(connectionId, tag) {
    const current = get().settings.connectionTags ?? {};
    const next: Record<string, 'prod' | 'staging' | 'dev' | 'local'> = { ...current };
    if (tag === null) {
      delete next[connectionId];
    } else {
      next[connectionId] = tag;
    }
    set({ settings: { ...get().settings, connectionTags: next } });
    try {
      await ipc.settings.set({ connectionTags: next });
    } catch (err) {
      console.error('[plasma] persist connectionTags failed', err);
    }
  },

  async resolveConnectionAction(choice: 'commit' | 'discard'): Promise<void> {
    const gate = get().connectionActionGate;
    if (!gate) return;
    if (choice === 'commit') await get().commitPendingEdits(); else set({ pendingEdits: [], pendingEditsError: null });
    set({ connectionActionGate: null });
    // Prod-tagged: the commit waits on its own confirmation — stop here and
    // let the user retry the connection action once the tray is empty.
    if (get().pendingEdits.length > 0) return;
    if (gate.kind === 'disconnect') await get().disconnect();
    else if (gate.kind === 'connect') await get().connect(gate.config);
    else await get().connectSaved(gate.id);
  },
  cancelConnectionAction() { set({ connectionActionGate: null }); },


  confirmProdGate() {
    const gate = get().prodGate;
    if (!gate) return;
    set({ prodGate: null });
    if (gate.kind === 'external') {
      settleExternalProdGate((get().connectionGen ?? 0) === gate.connectionGen);
      return;
    }
    // F8: the approved SQL only ever runs on the connection and tab it was
    // approved for. A reconnect in between voids the approval.
    if ((get().connectionGen ?? 0) !== gate.connectionGen) return;
    if (gate.kind === 'commitEdits') {
      // The grid's pending-changes tray: resume the confirmed commit.
      // Failures land in `pendingEditsError` for the grid to show.
      void get().commitPendingEdits({ confirmed: true }).catch(() => undefined);
      return;
    }
    // Re-enter runQuery with the captured payload so a selection/statement
    // run does not re-resolve from a moved caret (and so the gate does not
    // loop on the same destructive script). runQuery targets the active
    // tab, so bring the origin tab back first — or drop it if it's gone.
    if (get().activeTabId !== gate.tabId) {
      if (!get().tabs.some((t) => t.id === gate.tabId)) return;
      set({ activeTabId: gate.tabId });
    }
    void get().runQuery({ sql: gate.sql });
  },

  confirmUserSql(sql, opts) {
    return requestProdConfirm(set, get, sql, opts);
  },

  cancelProdGate() {
    cancelProdGateAction(set);
  },

  // ── SQL formatting ──

  async formatActiveSql() {
    const tab = activeTab(get());
    if (!tab || tab.kind !== 'sql') return;
    if (!tab.sql.trim()) return;
    try {
      const formatted = await ipc.sql.format(tab.sql);
      if (formatted && formatted !== tab.sql) {
        set({ tabs: get().tabs.map((t) => (t.id === tab.id ? { ...t, sql: formatted } : t)) });
      }
    } catch (err) {
      console.error('[plasma] formatActiveSql failed', err);
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


/** Prefer the last result that has columns (a SELECT); else the last result. */
function defaultActiveResultIndex(results: QueryResult[]): number {
  if (results.length === 0) return 0;
  for (let i = results.length - 1; i >= 0; i--) {
    if ((results[i]?.columns.length ?? 0) > 0) return i;
  }
  return results.length - 1;
}

function resultPatch(
  results: QueryResult[],
  activeIndex: number,
): Pick<QueryTab, 'queryResults' | 'activeResultIndex' | 'queryResult'> {
  if (results.length === 0) {
    return { queryResults: [], activeResultIndex: 0, queryResult: null };
  }
  const idx = Math.max(0, Math.min(activeIndex, results.length - 1));
  return {
    // Copy: the runner keeps pushing into `results` while statements
    // stream in, and subscribers memoize on array identity.
    queryResults: results.slice(),
    activeResultIndex: idx,
    queryResult: results[idx] ?? null,
  };
}

function mergeNotices(
  a: PgNotice[] | undefined,
  b: PgNotice[] | undefined,
): PgNotice[] {
  const out: PgNotice[] = [];
  const seen = new Set<string>();
  for (const n of [...(a ?? []), ...(b ?? [])]) {
    const key = `${n.severity ?? ''}|${n.code ?? ''}|${n.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
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
  // B4: always fetch primary-key columns — row edits need them even when
  // hidden. The grid hides them client-side via `hiddenColumns`.
  const pkNames = new Set(tablePkNames(state.schema, tab.tableSchema, tab.tableName));
  const fetchHidden =
    pkNames.size > 0
      ? new Set([...tab.hiddenColumns].filter((c: string) => !pkNames.has(c)))
      : tab.hiddenColumns;
  const { sql, params } = buildDataSql({
    schema: tab.tableSchema,
    table: tab.tableName,
    allColumns,
    hiddenColumns: fetchHidden,
    sort: tab.tableSort,
    filters: tab.filters,
    page: tab.page,
    pageSize: tab.pageSize,
    // B5/F17: deterministic paging — PK order (ctid for key-less tables).
    primaryKey: [...pkNames],
    ctidFallback:
      pkNames.size === 0 &&
      state.schema?.tables.find((t) => t.schema === tab.tableSchema && t.name === tab.tableName)
        ?.kind === 'table',
  });

  patchTabById(set, tabId, {
    queryRunState: 'running',
    queryError: null,
    queryErrorSql: null,
    sql, // store for display / copy
    runStartedAt: Date.now(),
  });

  // B1: only the newest request for this tab, on the same connection
  // generation, may publish — fast paging / sorting / filtering can't let
  // an older response overwrite a newer one, nor a pre-reconnect one land.
  const isCurrent = claimTableRequest(dataRequestGen, tabId, get);

  try {
    const result = await ipc.query.run(sql, params, { internal: true });
    if (!isCurrent()) return;
    patchTabById(set, tabId, {
      ...resultPatch([result], 0),
      queryRunState: 'idle',
      selectedCell: null,
      selectedRows: new Set(),
      queryNotices: [],
    });
  } catch (err) {
    if (!isCurrent()) return;
    patchTabById(set, tabId, {
      queryError: err instanceof Error ? err.message : String(err),
      queryErrorSql: sql,
      queryRunState: 'idle',
    });
  }
}

const dataRequestGen = new Map<string, number>();
const countRequestGen = new Map<string, number>();

/**
 * Stamp a new request for `tabId` and return a predicate that is true
 * only while it is still the newest one on the same connection
 * generation (and the tab still exists).
 */
function claimTableRequest(
  gens: Map<string, number>,
  tabId: string,
  get: () => SessionState,
): () => boolean {
  const gen = (gens.get(tabId) ?? 0) + 1;
  gens.set(tabId, gen);
  const connGen = get().connectionGen ?? 0;
  return () =>
    gens.get(tabId) === gen &&
    (get().connectionGen ?? 0) === connGen &&
    get().tabs.some((t) => t.id === tabId);
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
    (tableMeta?.kind === 'table' || tableMeta?.kind === 'matview') &&
    typeof tableMeta.rowCountEstimate === 'number' &&
    tableMeta.rowCountEstimate >= ESTIMATED_COUNT_THRESHOLD;

  // F8: COUNT(*) on a view or foreign table re-runs the whole view / a
  // remote scan on every page change. Skip it — the footer pages on
  // "full page ⇒ maybe more" instead.
  if (tableMeta?.kind === 'view' || tableMeta?.kind === 'foreign') {
    patchTabById(set, tabId, { totalRowCount: null, totalRowCountIsEstimate: false, countLoading: false });
    return;
  }

  patchTabById(set, tabId, { countLoading: true });
  const isCurrent = claimTableRequest(countRequestGen, tabId, get);

  const { sql, params } = useEstimate
    ? buildEstimatedCountSql(tab.tableSchema, tab.tableName)
    : buildCountSql({
        schema: tab.tableSchema,
        table: tab.tableName,
        filters: tab.filters,
      });

  try {
    // F12: counts run on the side connection (read-only, short timeout)
    // so they never queue behind — or get cancelled with — the user's
    // query. Under SET ROLE they must see what the role sees, so they
    // stay on the primary.
    const result = state.activeRole
      ? await ipc.query.run(sql, params, { internal: true })
      : await ipc.query.sideband(sql, params, { timeoutMs: LOOKUP_TIMEOUT_MS });
    if (!isCurrent()) return;
    const raw = result.rows[0]?.[0];
    const count = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number(raw);
    patchTabById(set, tabId, {
      totalRowCount: Number.isFinite(count) ? count : null,
      totalRowCountIsEstimate: useEstimate,
      countLoading: false,
    });
  } catch {
    if (isCurrent()) patchTabById(set, tabId, { countLoading: false });
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
    const res = await ipc.query.sideband(sql, params, { timeoutMs: LOOKUP_TIMEOUT_MS });
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

/**
 * Compose a short, engine-specific context blob for the AI system
 * prompt. Keeps the renderer in charge of what's worth surfacing —
 * main just forwards the string. Returns undefined when there's
 * nothing useful to send (postgres uses the schema field instead).
 */
function buildEngineContext(state: SessionState): string | undefined {
  const cfg = state.activeConfig;
  if (!cfg) return undefined;
  const engine = cfg.engine ?? 'postgres';

  if (engine === 'redis' && state.redisOverview) {
    const o = state.redisOverview;
    const lines: string[] = [
      `version: ${o.redisVersion}`,
      `role: ${o.role}`,
      `mode: ${o.mode}`,
    ];
    const total = o.keyspace.reduce((acc, k) => acc + k.keys, 0);
    if (total > 0) lines.push(`total keys: ${total.toLocaleString()}`);
    for (const k of o.keyspace.slice(0, 4)) {
      lines.push(`db${k.db}: ${k.keys.toLocaleString()} keys (${k.expires.toLocaleString()} with TTL)`);
    }
    if (state.redisKeys && state.redisKeys.keys.length > 0) {
      const sample = state.redisKeys.keys
        .slice(0, 12)
        .map((k) => `  ${k.key} (${k.type})`)
        .join('\n');
      lines.push('sample keys:', sample);
    }
    return lines.join('\n');
  }

  if (engine === 'opensearch' && state.osOverview) {
    const o = state.osOverview;
    const lines: string[] = [
      `cluster: ${o.clusterName}`,
      `${o.distribution} v${o.version}`,
      `health: ${o.health}`,
      `${o.nodes} node(s) · ${o.indices.length} indices`,
    ];
    if (o.indices.length > 0) {
      lines.push('top indices:');
      for (const idx of [...o.indices]
        .sort((a, b) => b.docsCount - a.docsCount)
        .slice(0, 12)) {
        lines.push(
          `  ${idx.index} — ${idx.docsCount.toLocaleString()} docs, ${idx.health}`,
        );
      }
    }
    return lines.join('\n');
  }

  return undefined;
}

/**
 * Bring the right kind of overview / introspection online based on
 * which engine the worker just connected to. Postgres uses the existing
 * `refreshSchema` (full table/column/FK introspection); Redis fetches
 * INFO + an initial SCAN page; OpenSearch fetches cluster + index list.
 */
async function loadEngineOverview(
  set: (patch: Partial<SessionState>) => void,
  get: () => SessionState,
  engine: ConnectionEngine,
): Promise<void> {
  if (engine === 'postgres') {
    await get().refreshSchema();
    const schema = get().schema;
    if (schema && schema.schemas.length > 0) {
      const first = schema.schemas.find((s) => s.name === 'public') ?? schema.schemas[0];
      set({ expandedSchemas: new Set([first.name]), currentSchema: first.name });
    }
    return;
  }
  if (engine === 'redis') {
    await get().refreshRedisOverview();
    await get().scanRedisKeys({ cursor: '0' });
    return;
  }
  if (engine === 'opensearch') {
    await get().refreshOsOverview();
  }
}

/** React hook helper: selects the currently active tab with proper memoization. */
export function useActiveTab(): QueryTab | undefined {
  return useSession((s) => s.tabs.find((t) => t.id === s.activeTabId));
}

/**
 * Narrow subscription to the active tab (F13). `useActiveTab()` returns the
 * whole tab, so every keystroke in the editor (which patches `sql`)
 * re-renders its subscribers; pick only the fields a component reads:
 *
 *   const { kind, queryRunState } = useActiveTabSelect((t) => ({ kind: t?.kind, queryRunState: t?.queryRunState }));
 *
 * Objects / arrays are compared shallowly.
 */
export function useActiveTabSelect<T>(pick: (tab: QueryTab | undefined) => T): T {
  return useSession(useShallow((s) => pick(s.tabs.find((t) => t.id === s.activeTabId))));
}

/**
 * After a connection is established, make the tab strip belong to it
 * (D1): restore that connection's saved tabs, or — when the open tabs
 * belong to a different connection — start from one fresh tab. Reconnects
 * to the same connection keep the live tabs, which are newer.
 */
function adoptConnectionTabs(
  set: (patch: Partial<SessionState>) => void,
  get: () => SessionState,
  engine: ConnectionEngine,
): void {
  const state = get();
  const connId = state.activeConfig?.id ?? null;
  if (connId && state.tabsConnectionId === connId) return;
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

installTabPersistence(useSession);

/**
 * B2: drop everything a tab holds that belongs to a server session —
 * results, selections, the inspected row — before a new session starts.
 * Tab identity/SQL stay (adoptConnectionTabs decides which tabs survive).
 */
function clearSessionScopedTabState(
  set: (fn: (state: SessionState) => Partial<SessionState>) => void,
  _get: () => SessionState,
): void {
  useWorkbench.getState().setInspectedRow(null);
  set((state) => ({
    tabs: state.tabs.map((t) => ({
      ...t,
      queryResult: null,
      queryResults: [],
      activeResultIndex: 0,
      queryNotices: [],
      queryError: null,
      page: 0,
      sortColumn: null,
      selectedCell: null,
      selectedRows: new Set<number>(),
      totalRowCount: null,
      rlsPolicyCount: null,
    })),
  }));
}
