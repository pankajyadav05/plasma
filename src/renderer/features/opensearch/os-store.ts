import type { OsFieldStats, OsRawResponse, OsSearchResult, OsSqlResult } from '@shared/protocol';
import { create } from 'zustand';

/**
 * OpenSearch view state that must survive tab switches (O7), plus the
 * query history / saved queries (O18), the write-confirm dialog and the
 * document editor dialog. Only the active tab's view is mounted, so
 * anything a user would expect to come back to lives here, keyed by
 * tab id.
 */

export type OsSearchViewMode = 'discover' | 'dsl';
export type OsResultMode = 'data' | 'json' | 'aggs';

/** Where page `n` starts: `from` offset or a `search_after` cursor (O3). */
export interface OsPageCursor {
  from?: number;
  searchAfter?: unknown[];
}

export interface OsSearchTabState {
  view: OsSearchViewMode;
  size: number;
  timeoutMs: number;
  running: boolean;
  requestId: string | null;
  error: string | null;
  result: OsSearchResult | null;
  /** Body of the page-0 request; paging re-issues it with a cursor. */
  baseBody: string | null;
  page: number;
  cursors: OsPageCursor[];
  mode: OsResultMode;
  /** null = the default column set (picked once the mapping loads). */
  selectedCols: string[] | null;
  fieldStats: Record<string, OsFieldStats>;
  /** Query the cached stats were computed for; a new run invalidates them. */
  statsKey: string;
  selected: number | null;
  fieldPaneOpen: boolean;
  fieldPaneWidth: number;
  /** Discover-mode server-side sort (O19). */
  sort: { field: string; dir: 'asc' | 'desc' } | null;
  /** Discover-mode time filter on the first date field (O19). */
  timeRange: string | null;
}

export interface OsSqlTabState {
  running: boolean;
  requestId: string | null;
  error: string | null;
  result: OsSqlResult | null;
  /** Extra rows fetched through the SQL cursor (O20). */
  mode: 'data' | 'json';
  selected: number | null;
  timeoutMs: number;
  fetchSize: number;
  explain: unknown | null;
}

export interface OsConsoleTabState {
  method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  body: string;
  running: boolean;
  requestId: string | null;
  error: string | null;
  response: OsRawResponse | null;
  timeoutMs: number;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

export function defaultSearchState(): OsSearchTabState {
  return {
    view: 'discover',
    size: 50,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    running: false,
    requestId: null,
    error: null,
    result: null,
    baseBody: null,
    page: 0,
    cursors: [{}],
    mode: 'data',
    selectedCols: null,
    fieldStats: {},
    statsKey: '',
    selected: null,
    fieldPaneOpen: true,
    fieldPaneWidth: 240,
    sort: null,
    timeRange: null,
  };
}

export function defaultSqlState(): OsSqlTabState {
  return {
    running: false,
    requestId: null,
    error: null,
    result: null,
    mode: 'data',
    selected: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    fetchSize: 200,
    explain: null,
  };
}

export function defaultConsoleState(): OsConsoleTabState {
  return {
    method: 'GET',
    path: '/_cluster/health',
    body: '',
    running: false,
    requestId: null,
    error: null,
    response: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
}

// ───────────── History + saved queries (O18) ─────────────

export type OsQueryKind = 'query' | 'dsl' | 'sql' | 'console';

export interface OsHistoryEntry {
  id: string;
  kind: OsQueryKind;
  /** query_string / DSL body / SQL text / console body. */
  text: string;
  index?: string;
  method?: string;
  path?: string;
  at: number;
  ok: boolean;
}

export interface OsSavedQuery {
  id: string;
  name: string;
  kind: OsQueryKind;
  text: string;
  index?: string;
  method?: string;
  path?: string;
  savedAt: number;
}

const HISTORY_KEY = 'plasma.os.history.v1';
const SAVED_KEY = 'plasma.os.saved.v1';
export const HISTORY_CAP = 200;

function load<T>(key: string): T[] {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function persist(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // Quota / private mode — history is best-effort.
  }
}

/** Newest first; an identical consecutive entry is replaced, not duplicated. */
export function pushHistory(list: OsHistoryEntry[], entry: OsHistoryEntry): OsHistoryEntry[] {
  const same = (e: OsHistoryEntry) =>
    e.kind === entry.kind &&
    e.text === entry.text &&
    e.index === entry.index &&
    e.method === entry.method &&
    e.path === entry.path;
  return [entry, ...list.filter((e) => !same(e))].slice(0, HISTORY_CAP);
}

// ───────────── Confirm dialog (S1) ─────────────

export interface OsConfirmRequest {
  title: string;
  description: string;
  confirmLabel: string;
  destructive: boolean;
  /** When set, the user must type this exact text to enable confirm. */
  typeToConfirm?: string;
  /** Shown when the connection is tagged prod. */
  prod: boolean;
  resolve: (ok: boolean) => void;
}

// ───────────── Document dialog (O13) ─────────────

export interface OsDocTarget {
  index: string;
  /** null = new document (id optional, assigned by the cluster). */
  id: string | null;
  /** Called after a successful save/delete so the view can re-run. */
  onDone?: () => void;
}

// ───────────── Store ─────────────

interface OsStore {
  search: Record<string, OsSearchTabState>;
  sql: Record<string, OsSqlTabState>;
  console: Record<string, OsConsoleTabState>;
  history: OsHistoryEntry[];
  saved: OsSavedQuery[];
  confirm: OsConfirmRequest | null;
  doc: OsDocTarget | null;
  /** Overview auto-refresh interval (S3); 0 = off. */
  overviewRefreshMs: number;
  overviewLoadedAt: number | null;

  patchSearch(tabId: string, patch: Partial<OsSearchTabState>): void;
  patchSql(tabId: string, patch: Partial<OsSqlTabState>): void;
  patchConsole(tabId: string, patch: Partial<OsConsoleTabState>): void;
  dropTab(tabId: string): void;
  addHistory(entry: Omit<OsHistoryEntry, 'id' | 'at'>): void;
  clearHistory(): void;
  saveQuery(q: Omit<OsSavedQuery, 'id' | 'savedAt'>): void;
  deleteSaved(id: string): void;
  setConfirm(req: OsConfirmRequest | null): void;
  openDoc(target: OsDocTarget | null): void;
  setOverviewRefreshMs(ms: number): void;
  markOverviewLoaded(): void;
}

let seq = 0;
export function newOsId(prefix = 'os'): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

export const useOsStore = create<OsStore>((set, get) => ({
  search: {},
  sql: {},
  console: {},
  history: load<OsHistoryEntry>(HISTORY_KEY),
  saved: load<OsSavedQuery>(SAVED_KEY),
  confirm: null,
  doc: null,
  overviewRefreshMs: 0,
  overviewLoadedAt: null,

  patchSearch(tabId, patch) {
    const cur = get().search[tabId] ?? defaultSearchState();
    set({ search: { ...get().search, [tabId]: { ...cur, ...patch } } });
  },
  patchSql(tabId, patch) {
    const cur = get().sql[tabId] ?? defaultSqlState();
    set({ sql: { ...get().sql, [tabId]: { ...cur, ...patch } } });
  },
  patchConsole(tabId, patch) {
    const cur = get().console[tabId] ?? defaultConsoleState();
    set({ console: { ...get().console, [tabId]: { ...cur, ...patch } } });
  },
  dropTab(tabId) {
    const { search, sql, console: con } = get();
    if (!(tabId in search) && !(tabId in sql) && !(tabId in con)) return;
    const { [tabId]: _a, ...s1 } = search;
    const { [tabId]: _b, ...s2 } = sql;
    const { [tabId]: _c, ...s3 } = con;
    set({ search: s1, sql: s2, console: s3 });
  },
  addHistory(entry) {
    const history = pushHistory(get().history, { ...entry, id: newOsId('h'), at: Date.now() });
    persist(HISTORY_KEY, history);
    set({ history });
  },
  clearHistory() {
    persist(HISTORY_KEY, []);
    set({ history: [] });
  },
  saveQuery(q) {
    const saved = [{ ...q, id: newOsId('q'), savedAt: Date.now() }, ...get().saved];
    persist(SAVED_KEY, saved);
    set({ saved });
  },
  deleteSaved(id) {
    const saved = get().saved.filter((q) => q.id !== id);
    persist(SAVED_KEY, saved);
    set({ saved });
  },
  setConfirm(req) {
    set({ confirm: req });
  },
  openDoc(target) {
    set({ doc: target });
  },
  setOverviewRefreshMs(ms) {
    set({ overviewRefreshMs: ms });
  },
  markOverviewLoaded() {
    set({ overviewLoadedAt: Date.now() });
  },
}));

/** Selector helpers returning the default state for unseen tabs. */
export function useSearchTab(tabId: string): OsSearchTabState {
  return useOsStore((s) => s.search[tabId]) ?? defaultSearchStateCached;
}
export function useSqlTab(tabId: string): OsSqlTabState {
  return useOsStore((s) => s.sql[tabId]) ?? defaultSqlStateCached;
}
export function useConsoleTab(tabId: string): OsConsoleTabState {
  return useOsStore((s) => s.console[tabId]) ?? defaultConsoleStateCached;
}

const defaultSearchStateCached = defaultSearchState();
const defaultSqlStateCached = defaultSqlState();
const defaultConsoleStateCached = defaultConsoleState();
