/**
 * Tab construction and patch helpers shared by the session slices: tab
 * factories, active-tab lookup, per-table column-state persistence and the
 * multi-result bookkeeping. No store creation here, so slices can import it
 * freely without cycles.
 */
import { ipc } from '@/lib/ipc';
import type { PgNotice, QueryResult, SchemaInfo } from '@shared/protocol';
import {
  IDLE_LIFECYCLE,
  endsTransaction,
  isBusyPhase,
  lifecycleFromLegacyPatch,
  reduceLifecycle,
} from '@shared/query-lifecycle';
import { looksLikeWrite } from './session-sql-heuristics';
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
    queryLifecycle: IDLE_LIFECYCLE,
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
    queryLifecycle: IDLE_LIFECYCLE,
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
    tabs: state.tabs.map((t) => (t.id === activeId ? { ...t, ...withLifecycle(t, patch) } : t)),
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
    // Columns an agent view hid are not the user's choice.
    hidden: [...tab.hiddenColumns].filter((c) => !tab.agentHiddenColumns?.has(c)),
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
    tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, ...withLifecycle(t, patch) } : t)),
  }));
}

/**
 * Keep `queryLifecycle` in step with the legacy `queryRunState` flag for
 * call sites that only flip the flag (table loads, AI runs, Safe Run). Paths
 * that know more (cancel, connection loss, outcome unknown) set the
 * lifecycle themselves and are left alone.
 */
function withLifecycle(tab: QueryTab, patch: Partial<QueryTab>): Partial<QueryTab> {
  if ('queryLifecycle' in patch || !('queryRunState' in patch)) return patch;
  const next = lifecycleFromLegacyPatch(
    tab.queryLifecycle,
    patch,
    typeof patch.queryError === 'string' && patch.queryError.length > 0,
    Date.now(),
  );
  return next ? { ...patch, queryLifecycle: next } : patch;
}

/**
 * What a connection reset does to a tab's run. A run still in flight is not
 * erased: it ends as disconnected (a read) or outcome unknown (a write that may
 * have landed), and the late failure from its request cannot change that.
 * An earlier "outcome unknown" is kept, since the user still has to check the data.
 */
function settleOnReset(t: QueryTab, now: number): Partial<QueryTab> | null {
  const life = t.queryLifecycle;
  if (life?.phase === 'unknown') return {};
  if (!life || !isBusyPhase(life.phase)) return null;
  const sql: string = (t.queryRunningSql as string | undefined) ?? '';
  const queued = life.phase === 'queued';
  const settled = reduceLifecycle(life, {
    type: 'fail',
    now,
    message: queued
      ? 'connection lost: the connection changed before this query started'
      : 'connection lost: the connection changed while the query was running',
    isWrite: !queued && sql !== '' && looksLikeWrite(sql),
    commitLike: !queued && sql !== '' && endsTransaction(sql),
    sql: sql || undefined,
  });
  const message = queued
    ? 'The connection changed before this query started, so it did not run.'
    : (settled.message ?? 'The connection changed while the query was running.');
  return {
    queryLifecycle: queued ? { ...settled, message } : settled,
    queryError: message,
    queryErrorSql: sql || null,
    queryRunState: 'idle',
    queryRunningRange: null,
  };
}

/**
 * Drop the results, selections and paging every tab holds — they reference
 * a connection that is gone. `extra` adds fields the caller also resets.
 */
export function clearTabResults(set: SetFn, extra: Partial<QueryTab> = {}): void {
  const now = Date.now();
  set((state) => ({
    tabs: state.tabs.map((t) => {
      const kept = settleOnReset(t, now);
      const base = {
        ...t,
        queryResult: null,
        queryResults: [],
        activeResultIndex: 0,
        queryNotices: [],
        page: 0,
        sortColumn: null,
        selectedCell: null,
        selectedRows: new Set<number>(),
      };
      if (kept === null) {
        return { ...base, queryError: null, queryLifecycle: IDLE_LIFECYCLE, ...extra };
      }
      // Busy runs and unknown outcomes keep their status; the rest of `extra` still applies.
      const {
        queryRunState: _state,
        queryRunningRange: _range,
        queryLifecycle: _life,
        queryError: _error,
        ...rest
      } = extra;
      return { ...base, ...rest, ...kept };
    }),
  }));
}

/** A copy of `items` with `item` added, or removed when it was already there. */
export function toggled<T>(items: ReadonlySet<T>, item: T): Set<T> {
  const next = new Set(items);
  if (next.has(item)) next.delete(item);
  else next.add(item);
  return next;
}
