/**
 * Tab construction and patch helpers shared by the session slices: tab
 * factories, active-tab lookup, per-table column-state persistence and the
 * multi-result bookkeeping. No store creation here, so slices can import it
 * freely without cycles.
 */
import { ipc } from '@/lib/ipc';
import type { PgNotice, QueryResult, SchemaInfo } from '@shared/protocol';
import type { QueryTab, SessionState } from './session-types';

type SetFn = (fn: (s: SessionState) => Partial<SessionState>) => void;

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

export function freshId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createEmptyTab(pageSize: number, title = 'query-1.sql'): QueryTab {
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

export function createTableTab(pageSize: number, schemaName: string, tableName: string): QueryTab {
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

export function columnsForTable(
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

export function columnMetaFor(
  schemaInfo: SchemaInfo | null,
  schemaName: string,
  tableName: string,
): SchemaInfo['columns'] {
  if (!schemaInfo) return [];
  return schemaInfo.columns
    .filter((c) => c.schema === schemaName && c.table === tableName)
    .sort((a, b) => a.ordinal - b.ordinal);
}

export function activeTab(state: SessionState): QueryTab | undefined {
  return state.tabs.find((t) => t.id === state.activeTabId);
}

export function patchActiveTab(
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
export function persistTableColumnState(
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
export function loadTableColumnStateInto(
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
export function defaultActiveResultIndex(results: QueryResult[]): number {
  if (results.length === 0) return 0;
  for (let i = results.length - 1; i >= 0; i--) {
    if ((results[i]?.columns.length ?? 0) > 0) return i;
  }
  return results.length - 1;
}

export function resultPatch(
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

export function mergeNotices(a: PgNotice[] | undefined, b: PgNotice[] | undefined): PgNotice[] {
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

export function patchTabById(
  set: (fn: (s: SessionState) => Partial<SessionState>) => void,
  tabId: string,
  patch: Partial<QueryTab>,
) {
  set((state) => ({
    tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)),
  }));
}

/**
 * Drop the results, selections and paging every tab holds — they reference
 * a connection that is gone. `extra` adds fields the caller also resets.
 */
export function clearTabResults(set: SetFn, extra: Partial<QueryTab> = {}): void {
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
      ...extra,
    })),
  }));
}

/** A copy of `items` with `item` added, or removed when it was already there. */
export function toggled<T>(items: ReadonlySet<T>, item: T): Set<T> {
  const next = new Set(items);
  if (next.has(item)) next.delete(item);
  else next.add(item);
  return next;
}
