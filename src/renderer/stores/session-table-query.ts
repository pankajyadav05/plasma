/**
 * Server-side data / count / RLS queries behind Postgres table tabs. Every
 * request is stamped so only the newest one on the same connection
 * generation may publish (B1).
 */
import { ipc } from '@/lib/ipc';
import {
  buildCountSql,
  buildDataSql,
  buildEstimatedCountSql,
  buildRlsCountSql,
} from '@/lib/table-query';
import { dialectFor, engineCaps } from '@shared/sql-dialect';
import { tablePkNames } from './session-pending-edits';
import { shouldUseEstimatedCount } from './session-sql-heuristics';
import { columnsForTable, patchTabById, resultPatch } from './session-tab-model';
import type { SessionState } from './session-types';

type SetFn = (fn: (s: SessionState) => Partial<SessionState>) => void;

/**
 * When a table is unfiltered AND the introspected estimate is above this
 * threshold, we use pg_class.reltuples instead of COUNT(*). For small
 * tables COUNT(*) is cheap and accurate; for huge tables it can take
 * minutes.
 */
const DEFAULT_ESTIMATED_COUNT_THRESHOLD = 100_000;

/** F12: timeout for Plasma's own lookups on the side connection. */
export const LOOKUP_TIMEOUT_MS = 15_000;

/**
 * Compile + run the data query for a table tab. Used on open, page
 * change, sort change, filter change, column visibility change.
 */
export async function runTableDataQuery(
  set: (fn: (s: SessionState) => Partial<SessionState>) => void,
  get: () => SessionState,
  tabId: string,
) {
  let state = get();
  let tab = state.tabs.find((t) => t.id === tabId);
  if (!tab || tab.kind !== 'table' || !tab.tableSchema || !tab.tableName) return;

  // R-06: the query is compiled from the table's columns (ORDER BY, hidden
  // columns, primary key). If its schema's columns haven't been loaded yet,
  // wait for them — otherwise page 0 is `SELECT * … ORDER BY ctid` and
  // later pages are PK-ordered.
  const columnsLoaded =
    !state.schema || !state.ensureSchemaColumns || state.columnSchemas?.has(tab.tableSchema);
  if (!columnsLoaded) {
    patchTabById(set, tabId, { queryRunState: 'running', queryError: null, queryErrorSql: null });
    const isCurrentEarly = claimTableRequest(dataRequestGen, tabId, get);
    await state.ensureSchemaColumns(tab.tableSchema);
    if (!isCurrentEarly()) return;
    // Hand over to a normal (re-claimed) run now that the columns are in.
    state = get();
    tab = state.tabs.find((t) => t.id === tabId);
    if (!tab || tab.kind !== 'table' || !tab.tableSchema || !tab.tableName) return;
  }

  const allColumns = columnsForTable(state.schema, tab.tableSchema, tab.tableName);
  // B4: always fetch primary-key columns — row edits need them even when
  // hidden. The grid hides them client-side via `hiddenColumns`.
  const pkNames = new Set(tablePkNames(state.schema, tab.tableSchema, tab.tableName));
  const fetchHidden =
    pkNames.size > 0
      ? new Set([...tab.hiddenColumns].filter((c: string) => !pkNames.has(c)))
      : tab.hiddenColumns;
  const dialect = dialectFor(state.activeConfig?.engine);
  const tableMeta = state.schema?.tables.find(
    (t) => t.schema === tab.tableSchema && t.name === tab.tableName,
  );
  // SQLite rowid tables without a declared key are addressed through `rowid`.
  const implicitKey = tableMeta?.implicitRowid;
  const { sql, params } = buildDataSql({
    dialect,
    implicitKey,
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
    ctidFallback: pkNames.size === 0 && tableMeta?.kind === 'table',
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

/** Reload a table tab: the page is awaited, its count follows in the background. */
export async function reloadTableTab(set: SetFn, get: () => SessionState, tabId: string) {
  await runTableDataQuery(set, get, tabId);
  void runTableCountQuery(set, get, tabId);
}

/** First load of a table tab: data + count (+ the RLS badge) run in parallel. */
export function loadTableTab(set: SetFn, get: () => SessionState, tabId: string, withRls = false) {
  void runTableDataQuery(set, get, tabId);
  void runTableCountQuery(set, get, tabId);
  if (withRls && engineCaps(get().activeConfig?.engine).pgExtras) {
    void runRlsCountForTab(set, get, tabId);
  }
}

/** Index of the last page for `total` rows (0 for an empty table). */
export function lastPageIndex(total: number, pageSize: number): number {
  if (!(pageSize > 0) || total <= 0) return 0;
  return Math.ceil(total / pageSize) - 1;
}

/** First integer of a `SELECT count(*)`-style result cell, or null. */
export function parseCount(raw: unknown): number | null {
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number(raw);
  return Number.isFinite(n) ? n : null;
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
export async function runTableCountQuery(
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
  const dialect = dialectFor(state.activeConfig?.engine);
  const useEstimate =
    dialect.estimatedCount('', '') !== null &&
    tab.filters.length === 0 &&
    (tableMeta?.kind === 'table' || tableMeta?.kind === 'matview') &&
    shouldUseEstimatedCount(
      state.settings.estimatedCountThreshold ?? DEFAULT_ESTIMATED_COUNT_THRESHOLD,
      tableMeta.rowCountEstimate,
    );

  // F8: COUNT(*) on a view or foreign table re-runs the whole view / a
  // remote scan on every page change. Skip it — the footer pages on
  // "full page ⇒ maybe more" instead.
  if (tableMeta?.kind === 'view' || tableMeta?.kind === 'foreign') {
    patchTabById(set, tabId, {
      totalRowCount: null,
      totalRowCountIsEstimate: false,
      countLoading: false,
    });
    return;
  }

  patchTabById(set, tabId, { countLoading: true });
  const isCurrent = claimTableRequest(countRequestGen, tabId, get);

  const { sql, params } = useEstimate
    ? buildEstimatedCountSql(tab.tableSchema, tab.tableName, dialect)
    : buildCountSql({
        dialect,
        schema: tab.tableSchema,
        table: tab.tableName,
        filters: tab.filters,
      });

  try {
    // F12: counts run on the side connection (read-only, short timeout)
    // so they never queue behind — or get cancelled with — the user's
    // query. Under SET ROLE they must see what the role sees, so they
    // stay on the primary.
    const result =
      state.activeRole || !engineCaps(state.activeConfig?.engine).sideband
        ? await ipc.query.run(sql, params, { internal: true })
        : await ipc.query.sideband(sql, params, { timeoutMs: LOOKUP_TIMEOUT_MS });
    if (!isCurrent()) return;
    const raw = result.rows[0]?.[0];
    const total = parseCount(raw);
    patchTabById(set, tabId, {
      totalRowCount: total,
      totalRowCountIsEstimate: useEstimate,
      countLoading: false,
    });
    // R-32: a filter / delete shrank the table below the current page. The
    // footer only clamped its label; move the real page and re-query.
    const current = get().tabs.find((t) => t.id === tabId);
    if (current && total !== null && !useEstimate) {
      const last = lastPageIndex(total, current.pageSize);
      if (current.page > last) {
        patchTabById(set, tabId, { page: last });
        void runTableDataQuery(set, get, tabId);
      }
    }
  } catch {
    if (isCurrent()) patchTabById(set, tabId, { countLoading: false });
  }
}

export async function runRlsCountForTab(
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
    patchTabById(set, tabId, {
      rlsPolicyCount: parseCount(raw) ?? 0,
    });
  } catch {
    // pg_policies may be unreadable for unprivileged roles — silently
    // leave rlsPolicyCount null. The badge will be hidden.
  }
}
