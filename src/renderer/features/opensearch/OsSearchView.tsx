import { type DataColumn, DataTable } from '@/components/ui/data-table';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { EmptyState, ViewFooter } from '@/components/ui/view-parts';
import { IconButton, MenuItem, Pill, Segmented } from '@/components/ui/workbench';
import { SidebarSearch, SidebarSearchRow, sidebarRowClass } from '@/features/sidebar/sidebar-parts';
import { cn } from '@/lib/cn';
import { ipc } from '@/lib/ipc';
import { kbd } from '@/lib/platform';
import { useSession } from '@/stores/session';
import { useWorkbench } from '@/stores/workbench';
import type { OsFieldStats, OsHit, OsMappingNode } from '@shared/protocol';
import {
  ArrowDown,
  ArrowUp,
  CalendarClock,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  FilePlus2,
  Loader2,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Search,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type CaretInfo, OsCodeEditor, SplitHandle, caretText } from './OsCodeEditor';
import {
  type AggRow,
  type LeafField,
  TIME_RANGES,
  buildDiscoverBody,
  displayValue,
  flattenAggregations,
  flattenSource,
  formatMs,
  getPath,
  hitsToCsv,
  hitsToJson,
  mappingLeafFields,
  nextPageCursor,
  pageBody,
  pickDefaultColumns,
  queryOfBody,
  sortPath,
  sourceOf,
  totalLabel,
} from './os-format';
import {
  EditorBar,
  JsonBody,
  OsBadge,
  QueryErrorPanel,
  QueryLibraryMenu,
  RunPill,
  RunningState,
  TimeoutMenu,
  clearInspected,
  errMessage,
  isRunShortcut,
} from './os-parts';
import {
  type OsSearchTabState,
  defaultSearchState,
  newOsId,
  useOsStore,
  useSearchTab,
} from './os-store';
import { confirmOsWrite, useOsWriteAccess } from './os-write';

const SIZE_CHOICES = [20, 50, 100, 500, 1000] as const;
const DEFAULT_BODY = '{\n  "query": { "match_all": {} },\n  "size": 50\n}\n';
/** Below this canvas width the field list collapses on its own (F12). */
const COLLAPSE_BELOW = 820;

/**
 * OpenSearch Discover-style canvas, laid out like the Postgres SQL tab.
 *
 *   - Left: field list (dotted leaf paths, type badges, visibility,
 *     per-field cardinality + top values). Collapsible and resizable.
 *   - Right: query-string field (or the Monaco DSL editor) → editor bar →
 *     hits grid / JSON / aggregations → footer with paging.
 *
 * View state lives in the OpenSearch store keyed by tab id, so switching
 * tabs and coming back keeps results, columns and settings (O7).
 */
export function OsSearchView({ tabId, indexName }: { tabId: string; indexName: string }) {
  return <OsSearchViewInner key={`${tabId}:${indexName}`} tabId={tabId} indexName={indexName} />;
}

function persistTab(tabId: string, patch: { osQueryString?: string; osBody?: string }) {
  useSession.setState((state) => ({
    tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)),
  }));
}

function bodySize(base: string | null, fallback: number): number {
  if (!base) return fallback;
  try {
    const n = (JSON.parse(base) as { size?: unknown }).size;
    return typeof n === 'number' && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

function OsSearchViewInner({ tabId, indexName }: { tabId: string; indexName: string }) {
  const tab = useSession((s) => s.tabs.find((t) => t.id === tabId));
  const st = useSearchTab(tabId);
  const patch = useCallback(
    (p: Partial<OsSearchTabState>) => useOsStore.getState().patchSearch(tabId, p),
    [tabId],
  );
  const getSt = useCallback(
    () => useOsStore.getState().search[tabId] ?? defaultSearchState(),
    [tabId],
  );
  const access = useOsWriteAccess();
  const openDoc = useOsStore((s) => s.openDoc);
  const addHistory = useOsStore((s) => s.addHistory);

  const [queryString, setQueryString] = useState(tab?.osQueryString ?? '');
  const [body, setBody] = useState(tab?.osBody ?? DEFAULT_BODY);
  const [caret, setCaret] = useState<CaretInfo | null>(null);
  const [mapping, setMapping] = useState<OsMappingNode | null>(null);
  const [mappingError, setMappingError] = useState<string | null>(null);
  const [fieldFilter, setFieldFilter] = useState('');
  const [fieldMenu, setFieldMenu] = useState(false);
  const [sizeMenu, setSizeMenu] = useState(false);
  const [timeMenu, setTimeMenu] = useState(false);
  const [actionsMenu, setActionsMenu] = useState(false);
  const [statsLoading, setStatsLoading] = useState(false);
  const [dslHeight, setDslHeight] = useState(220);
  const [narrow, setNarrow] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const rootRef = useRef<HTMLElement>(null);

  // F12: collapse the field pane automatically in a narrow canvas.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 1000;
      setNarrow(w < COLLAPSE_BELOW);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const root = await ipc.os.mapping(indexName);
        if (!cancelled) setMapping(root);
      } catch (err) {
        if (!cancelled) setMappingError(errMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [indexName]);

  const leaves = useMemo(() => (mapping ? mappingLeafFields(mapping.children) : []), [mapping]);
  const leafByPath = useMemo(() => new Map(leaves.map((l) => [l.path, l])), [leaves]);
  const timeField = useMemo(
    () => leaves.find((l) => l.type === 'date' || l.type === 'date_nanos')?.path ?? null,
    [leaves],
  );
  const selectedCols = useMemo(
    () => st.selectedCols ?? pickDefaultColumns(leaves),
    [st.selectedCols, leaves],
  );

  const discoverBody = useCallback(
    (over?: Partial<Pick<OsSearchTabState, 'sort' | 'timeRange' | 'size'>>, qs = queryString) => {
      const cur = getSt();
      return buildDiscoverBody({
        queryString: qs,
        size: over?.size ?? cur.size,
        sort: over && 'sort' in over ? (over.sort ?? null) : cur.sort,
        timeField,
        timeRange: over && 'timeRange' in over ? (over.timeRange ?? null) : cur.timeRange,
      });
    },
    [getSt, queryString, timeField],
  );

  // ── Field stats (O2): per field, refreshed when the query changes ──
  const loadStats = useCallback(
    async (fields: string[], statsQuery: string | undefined, key: string) => {
      if (fields.length === 0) return;
      setStatsLoading(true);
      try {
        const stats = await ipc.os.fieldStats({ index: indexName, fields, query: statsQuery });
        const cur = getSt();
        if (cur.statsKey !== key) return;
        const next = { ...cur.fieldStats };
        for (const s of stats) next[s.field] = s;
        patch({ fieldStats: next });
      } catch (err) {
        const cur = getSt();
        if (cur.statsKey !== key) return;
        const next = { ...cur.fieldStats };
        for (const f of fields) {
          next[f] = {
            field: f,
            type: leafByPath.get(f)?.type ?? null,
            cardinality: null,
            topValues: [],
            isTime: false,
            error: errMessage(err),
          };
        }
        patch({ fieldStats: next });
      } finally {
        setStatsLoading(false);
      }
    },
    [indexName, getSt, patch, leafByPath],
  );

  const currentStatsQuery = useCallback((): string | undefined => {
    const cur = getSt();
    if (cur.baseBody) return queryOfBody(cur.baseBody);
    return undefined;
  }, [getSt]);

  // First load: stats for the first 10 fields once the mapping arrives.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the mapping arrives
  useEffect(() => {
    if (leaves.length === 0) return;
    const cur = getSt();
    if (Object.keys(cur.fieldStats).length > 0) return;
    void loadStats(
      leaves.slice(0, 10).map((l) => l.path),
      currentStatsQuery(),
      cur.statsKey,
    );
  }, [leaves]);

  // ── Running (O3 paging, O6 timeout + cancel) ──
  const run = useCallback(
    async (page = 0, cursorArg?: { from?: number; searchAfter?: unknown[] }) => {
      const cur = getSt();
      if (cur.running) return;
      let base: string;
      if (page === 0) {
        base = cur.view === 'dsl' ? body : JSON.stringify(discoverBody());
      } else {
        if (!cur.baseBody) return;
        base = cur.baseBody;
      }
      let text = base;
      try {
        if (page > 0 && cursorArg) text = pageBody(base, cursorArg);
      } catch (err) {
        patch({ error: errMessage(err) });
        return;
      }
      const requestId = newOsId('search');
      patch({ running: true, requestId, error: null, selected: null });
      setNotice(null);
      clearInspected(tabId);
      try {
        const r = await ipc.os.search({
          index: indexName,
          body: text,
          size: cur.size,
          timeoutMs: cur.timeoutMs,
          requestId,
        });
        if (getSt().requestId !== requestId) return;
        const cursors = page === 0 ? [{}] : [...getSt().cursors];
        if (page > 0 && cursorArg) cursors[page] = cursorArg;
        const statsKey = page === 0 ? base : getSt().statsKey;
        const statsChanged = page === 0 && statsKey !== getSt().statsKey;
        patch({
          running: false,
          requestId: null,
          result: r,
          baseBody: base,
          page,
          cursors,
          ...(statsChanged ? { statsKey, fieldStats: {} } : {}),
          mode: getSt().mode === 'aggs' && !r.aggregations ? 'data' : getSt().mode,
        });
        if (page === 0) {
          addHistory({
            kind: cur.view === 'dsl' ? 'dsl' : 'query',
            text: cur.view === 'dsl' ? body : queryString,
            index: indexName,
            ok: true,
          });
          if (statsChanged) {
            const visible = [
              ...new Set([...selectedCols, ...leaves.slice(0, 10).map((l) => l.path)]),
            ];
            void loadStats(visible.slice(0, 20), queryOfBody(base), statsKey);
          }
        }
      } catch (err) {
        if (getSt().requestId !== requestId) return;
        const msg = errMessage(err);
        patch({
          running: false,
          requestId: null,
          error: /request cancelled/i.test(msg) ? 'Request cancelled' : msg,
          ...(page === 0 ? { result: null } : {}),
        });
        if (page === 0) {
          addHistory({
            kind: cur.view === 'dsl' ? 'dsl' : 'query',
            text: cur.view === 'dsl' ? body : queryString,
            index: indexName,
            ok: false,
          });
        }
      }
    },
    [
      getSt,
      body,
      discoverBody,
      patch,
      tabId,
      indexName,
      addHistory,
      queryString,
      selectedCols,
      leaves,
      loadStats,
    ],
  );

  const cancel = () => {
    const id = getSt().requestId;
    if (id) void ipc.os.cancel(id).catch(() => undefined);
  };

  const rerunCurrentPage = () => {
    const cur = getSt();
    if (cur.page === 0) void run(0);
    else void run(cur.page, cur.cursors[cur.page]);
  };

  // Drop this tab's row from the Details sidebar when the view goes away.
  useEffect(() => () => clearInspected(tabId), [tabId]);

  const result = st.result;
  const pageSize = bodySize(st.baseBody, st.size);
  const nextCursor = result ? nextPageCursor(result, st.page, pageSize) : null;
  const pageStart = st.page * pageSize;

  const toggleColumn = (field: string) => {
    const next = selectedCols.includes(field)
      ? selectedCols.filter((f) => f !== field)
      : [...selectedCols, field];
    patch({ selectedCols: next });
  };

  const setSort = (path: string) => {
    if (st.view !== 'discover') return;
    const leaf = leafByPath.get(path);
    const field = sortPath(leaf, path);
    if (!field) return;
    const cur = st.sort;
    const next: OsSearchTabState['sort'] =
      !cur || cur.field !== field
        ? { field, dir: 'asc' }
        : cur.dir === 'asc'
          ? { field, dir: 'desc' }
          : null;
    patch({ sort: next });
    queueMicrotask(() => void run(0));
  };

  const visibleFields = useMemo(() => {
    const q = fieldFilter.trim().toLowerCase();
    return q ? leaves.filter((f) => f.path.toLowerCase().includes(q)) : leaves;
  }, [leaves, fieldFilter]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: setSort reads the latest state
  const columns = useMemo<DataColumn<OsHit>[]>(() => {
    const sortLabel = (path: string, label: string) => {
      const field = sortPath(leafByPath.get(path), path);
      const active = st.sort && field && st.sort.field === field ? st.sort.dir : null;
      if (st.view !== 'discover' || !field) return label;
      return (
        <button
          type="button"
          onClick={() => setSort(path)}
          className="inline-flex items-center gap-1 hover:text-[var(--wb-text)]"
          title={`Sort by ${field}`}
        >
          {label}
          {active === 'asc' && <ArrowUp className="h-3 w-3" />}
          {active === 'desc' && <ArrowDown className="h-3 w-3" />}
        </button>
      );
    };
    return [
      {
        key: '_id',
        label: '_id',
        title: '_id — document id',
        width: 120,
        render: (h) => h.id,
        titleOf: (h) => h.id,
      },
      {
        key: '_score',
        label: '_score',
        title: '_score — relevance',
        align: 'right',
        width: 72,
        render: (h) => (h.score === null ? null : h.score.toFixed(2)),
      },
      ...selectedCols.map<DataColumn<OsHit>>((c) => {
        const type = leafByPath.get(c)?.type ?? null;
        return {
          key: `f:${c}`,
          label: sortLabel(c, c),
          title: type ? `${c} — ${type}` : c,
          render: (h) => displayValue(getPath(sourceOf(h), c), type),
          titleOf: (h) => displayValue(getPath(sourceOf(h), c), type) ?? undefined,
        };
      }),
    ];
  }, [selectedCols, leafByPath, st.sort, st.view]);

  // F28: publish the whole flattened document to the Details pane.
  const onSelectHit = (hit: OsHit, index: number) => {
    patch({ selected: index });
    const flat = flattenSource(sourceOf(hit));
    const entries = Object.entries(flat);
    useWorkbench.getState().setInspectedRow({
      tabId,
      rowNumber: pageStart + index + 1,
      columnIndex: 0,
      columns: [
        { name: '_id', dataTypeID: 0, dataTypeName: 'id' },
        { name: '_index', dataTypeID: 0, dataTypeName: 'index' },
        { name: '_score', dataTypeID: 0, dataTypeName: 'score' },
        ...entries.map(([name, value]) => ({
          name,
          dataTypeID: 0,
          dataTypeName: leafByPath.get(name)?.type ?? jsType(value),
        })),
      ],
      row: [
        hit.id,
        hit.index,
        hit.score,
        ...entries.map(([name, v]) =>
          leafByPath.get(name)?.type === 'geo_point' ? displayValue(v, 'geo_point') : v,
        ),
      ],
    });
  };

  const selectedHit = st.selected !== null ? result?.hits[st.selected] : undefined;

  const openHit = (hit: OsHit) =>
    openDoc({ index: hit.index, id: hit.id, onDone: rerunCurrentPage });

  const deleteHit = async (hit: OsHit) => {
    const ok = await confirmOsWrite({
      title: 'Delete document?',
      description: `Document ${hit.id} will be permanently removed from ${hit.index}.`,
      confirmLabel: 'Delete document',
      destructive: true,
    });
    if (!ok) return;
    try {
      const res = await ipc.os.request({
        method: 'DELETE',
        path: `/${encodeURIComponent(hit.index)}/_doc/${encodeURIComponent(hit.id)}?refresh=wait_for`,
      });
      if (res.status >= 400 && res.status !== 404) throw new Error(JSON.stringify(res.body));
      setNotice(`Deleted ${hit.id}`);
      rerunCurrentPage();
    } catch (err) {
      setNotice(`Delete failed: ${errMessage(err)}`);
    }
  };

  const deleteMatching = async () => {
    if (!result || !st.baseBody) return;
    const q = queryOfBody(st.baseBody) ?? '{"match_all":{}}';
    const ok = await confirmOsWrite({
      title: 'Delete matching documents?',
      description: `${totalLabel(result)} documents in ${indexName} match the current query and will be permanently deleted (_delete_by_query).`,
      confirmLabel: 'Delete documents',
      destructive: true,
      typeToConfirm: indexName,
    });
    if (!ok) return;
    try {
      const res = await ipc.os.request({
        method: 'POST',
        path: `/${encodeURIComponent(indexName).replace(/%2A/gi, '*')}/_delete_by_query?refresh=true&conflicts=proceed`,
        body: JSON.stringify({ query: JSON.parse(q) }),
        timeoutMs: 600_000,
      });
      const b = res.body as { deleted?: number; failures?: unknown[]; error?: { reason?: string } };
      if (res.status >= 400) throw new Error(b.error?.reason ?? JSON.stringify(res.body));
      setNotice(`Deleted ${(b.deleted ?? 0).toLocaleString()} documents`);
      void run(0);
    } catch (err) {
      setNotice(`Delete failed: ${errMessage(err)}`);
    }
  };

  const copy = (text: string, what: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => setNotice(`Copied ${what}`))
      .catch(() => setNotice('Copy failed'));
  };

  const addFilter = (field: string, value: string) => {
    const leaf = leafByPath.get(field);
    const target = leaf?.type === 'text' && leaf.keyword ? leaf.keyword : field;
    const clause = `${target}:"${value.replace(/(["\\])/g, '\\$1')}"`;
    const next = queryString.trim() ? `${queryString.trim()} AND ${clause}` : clause;
    setQueryString(next);
    persistTab(tabId, { osQueryString: next });
    if (st.view !== 'discover') patch({ view: 'discover' });
    queueMicrotask(() => void run(0));
  };

  const paneOpen = st.fieldPaneOpen && !narrow;
  const hasAggs = !!result?.aggregations && Object.keys(result.aggregations as object).length > 0;

  return (
    <main
      ref={rootRef}
      className="flex min-h-0 min-w-0 flex-1 overflow-hidden bg-[var(--wb-content)]"
      onKeyDown={(e) => {
        // O8: ⌘⏎ only runs when focus is inside this view.
        if (isRunShortcut(e)) {
          e.preventDefault();
          void run(0);
        }
      }}
    >
      {paneOpen && (
        <FieldPane
          indexName={indexName}
          width={st.fieldPaneWidth}
          onResize={(w) => patch({ fieldPaneWidth: w })}
          fieldFilter={fieldFilter}
          setFieldFilter={setFieldFilter}
          fieldMenu={fieldMenu}
          setFieldMenu={setFieldMenu}
          leaves={leaves}
          visibleFields={visibleFields}
          selectedCols={selectedCols}
          fieldStats={st.fieldStats}
          statsLoading={statsLoading}
          mappingError={mappingError}
          loaded={mapping !== null}
          onShowAll={() => patch({ selectedCols: leaves.map((l) => l.path) })}
          onHideAll={() => patch({ selectedCols: [] })}
          onReset={() => patch({ selectedCols: null })}
          onToggle={toggleColumn}
          onLoadStats={(f) => {
            if (!st.fieldStats[f]) void loadStats([f], currentStatsQuery(), st.statsKey);
          }}
          onFilter={addFilter}
        />
      )}

      {/* Query + hits */}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {st.view === 'discover' ? (
          <form
            className="shrink-0 bg-[var(--wb-content)] px-2.5 py-2"
            onSubmit={(e) => {
              e.preventDefault();
              void run(0);
            }}
          >
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--wb-text-2)]" />
              <input
                type="text"
                value={queryString}
                onChange={(e) => {
                  setQueryString(e.target.value);
                  persistTab(tabId, { osQueryString: e.target.value });
                }}
                aria-label="Query string"
                spellCheck={false}
                placeholder="status:200 AND user.id:* — query_string syntax (Enter to run)"
                className="h-7 w-full rounded-[7px] border-0 bg-[var(--wb-field)] pl-7 pr-2 font-mono text-[13px] text-[var(--wb-text)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--wb-text)_8%,transparent)] outline-none transition-shadow placeholder:text-[var(--wb-text-3)] focus:shadow-[0_0_0_2px_color-mix(in_srgb,var(--wb-accent)_55%,transparent)]"
              />
            </div>
          </form>
        ) : (
          <>
            <div className="shrink-0" style={{ height: dslHeight }}>
              <OsCodeEditor
                value={body}
                onChange={(v) => {
                  setBody(v);
                  persistTab(tabId, { osBody: v });
                }}
                onCaret={setCaret}
                onRun={() => void run(0)}
                language="json"
                ariaLabel="Query DSL"
                fields={leaves.flatMap((l) => (l.keyword ? [l.path, l.keyword] : [l.path]))}
                className="h-full"
              />
            </div>
            <SplitHandle height={dslHeight} onResize={setDslHeight} />
          </>
        )}

        <EditorBar
          hint={
            st.view === 'dsl'
              ? caret
                ? caretText(caret)
                : `${indexName} · POST /_search`
              : `${indexName} · query_string`
          }
          right={
            <>
              {!paneOpen && !narrow && (
                <IconButton
                  variant="plain"
                  label="Show field list"
                  onClick={() => patch({ fieldPaneOpen: true })}
                >
                  <PanelLeftOpen />
                </IconButton>
              )}
              {paneOpen && (
                <IconButton
                  variant="plain"
                  label="Hide field list"
                  onClick={() => patch({ fieldPaneOpen: false })}
                >
                  <PanelLeftClose />
                </IconButton>
              )}
              {st.view === 'discover' && timeField && (
                <Popover open={timeMenu} onOpenChange={setTimeMenu}>
                  <PopoverTrigger asChild>
                    <IconButton
                      variant="plain"
                      label={`Time range on ${timeField}: ${
                        TIME_RANGES.find((t) => t.value === st.timeRange)?.label ?? 'all time'
                      }`}
                      active={st.timeRange !== null}
                    >
                      <CalendarClock />
                    </IconButton>
                  </PopoverTrigger>
                  <PopoverContent
                    align="end"
                    side="top"
                    sideOffset={6}
                    className="w-[200px] p-1"
                    role="menu"
                  >
                    <div className="px-2 pb-1 pt-0.5 font-mono text-[12px] text-[var(--wb-text-2)]">
                      {timeField}
                    </div>
                    {[{ value: '', label: 'All time' }, ...TIME_RANGES].map((t) => (
                      <MenuItem
                        key={t.value}
                        label={t.label}
                        checked={(st.timeRange ?? '') === t.value}
                        onClick={() => {
                          patch({ timeRange: t.value || null });
                          setTimeMenu(false);
                          queueMicrotask(() => void run(0));
                        }}
                      />
                    ))}
                  </PopoverContent>
                </Popover>
              )}
              <QueryLibraryMenu
                kinds={['query', 'dsl']}
                current={
                  st.view === 'dsl'
                    ? { kind: 'dsl', text: body, index: indexName }
                    : { kind: 'query', text: queryString, index: indexName }
                }
                onPick={(e) => {
                  if (e.kind === 'dsl') {
                    setBody(e.text);
                    persistTab(tabId, { osBody: e.text });
                    patch({ view: 'dsl' });
                  } else {
                    setQueryString(e.text);
                    persistTab(tabId, { osQueryString: e.text });
                    patch({ view: 'discover' });
                  }
                }}
              />
              <TimeoutMenu value={st.timeoutMs} onChange={(ms) => patch({ timeoutMs: ms })} />
              <Segmented
                variant="track"
                ariaLabel="Query mode"
                value={st.view}
                onChange={(v) => {
                  if (
                    v === 'dsl' &&
                    st.view === 'discover' &&
                    (!tab?.osBody || body === DEFAULT_BODY)
                  ) {
                    // Seed the DSL editor from the current discover query.
                    const seeded = `${JSON.stringify(discoverBody(), null, 2)}\n`;
                    setBody(seeded);
                    persistTab(tabId, { osBody: seeded });
                  }
                  patch({ view: v });
                }}
                options={[
                  { value: 'discover', label: 'Query', title: 'query_string search' },
                  { value: 'dsl', label: 'DSL', title: 'Toggle DSL editor' },
                ]}
              />
              <Popover open={sizeMenu} onOpenChange={setSizeMenu}>
                <PopoverTrigger asChild>
                  <Pill title="Documents per page — a DSL body with its own size wins">
                    <span className="whitespace-nowrap">{st.size.toLocaleString()}</span>
                    <ChevronDown className="!h-3.5 !w-3.5 opacity-70" />
                  </Pill>
                </PopoverTrigger>
                <PopoverContent
                  align="end"
                  side="top"
                  sideOffset={6}
                  className="w-[160px] p-1"
                  role="menu"
                >
                  {SIZE_CHOICES.map((n) => (
                    <MenuItem
                      key={n}
                      label={`${n.toLocaleString()} per page`}
                      checked={st.size === n}
                      onClick={() => {
                        patch({ size: n });
                        setSizeMenu(false);
                      }}
                    />
                  ))}
                </PopoverContent>
              </Popover>
              <RunPill running={st.running} onRun={() => void run(0)} onCancel={cancel} />
            </>
          }
        />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col border-t border-[var(--wb-separator)]">
          {st.error ? (
            <QueryErrorPanel message={st.error} />
          ) : st.running && !result ? (
            <RunningState label="Searching…" />
          ) : !result ? (
            <EmptyState
              title="No results"
              hint={`Press Run (${kbd('⏎')}) to search ${indexName}.`}
            />
          ) : st.mode === 'json' ? (
            <JsonBody
              value={{
                total: { value: result.total, relation: result.totalRelation },
                hits: result.hits.map((h) => ({
                  _index: h.index,
                  _id: h.id,
                  _score: h.score,
                  _source: h.source,
                })),
                ...(hasAggs ? { aggregations: result.aggregations } : {}),
              }}
            />
          ) : st.mode === 'aggs' && hasAggs ? (
            <AggregationsView aggs={result.aggregations} />
          ) : result.hits.length === 0 ? (
            <EmptyState
              title="No hits"
              hint={
                hasAggs
                  ? 'The query returned aggregations only — switch to Aggregations below.'
                  : 'Nothing in this index matched the query.'
              }
            />
          ) : (
            <DataTable
              ariaLabel="Search hits"
              columns={columns}
              rows={result.hits}
              rowKey={(h, i) => `${h.index}/${h.id}/${i}`}
              selectedIndex={st.selected}
              onSelect={onSelectHit}
              onActivate={openHit}
              rowNumberOffset={pageStart}
            />
          )}
        </div>

        {(result || notice) && (
          <ViewFooter className="min-w-0 overflow-hidden whitespace-nowrap">
            {result && (
              <Segmented
                variant="track"
                ariaLabel="Result view"
                value={st.mode === 'aggs' && !hasAggs ? 'data' : st.mode}
                onChange={(m) => patch({ mode: m })}
                options={[
                  { value: 'data', label: 'Data' },
                  { value: 'json', label: 'JSON' },
                  ...(hasAggs ? [{ value: 'aggs' as const, label: 'Aggregations' }] : []),
                ]}
              />
            )}
            {result && <span className="shrink-0 tabular-nums">{formatMs(result.took)}</span>}
            <div className="flex min-w-0 flex-1 items-center justify-center gap-1 tabular-nums">
              {notice ? (
                <span className="truncate">{notice}</span>
              ) : result ? (
                <>
                  <IconButton
                    variant="plain"
                    label="Previous page"
                    disabled={st.page === 0 || st.running}
                    onClick={() => void run(st.page - 1, st.cursors[st.page - 1])}
                  >
                    <ChevronLeft />
                  </IconButton>
                  <span className="truncate">
                    {result.hits.length === 0
                      ? `0 of ${totalLabel(result)} hits`
                      : `${(pageStart + 1).toLocaleString()}–${(
                          pageStart + result.hits.length
                        ).toLocaleString()} of ${totalLabel(result)} ${result.total === 1 ? 'hit' : 'hits'}`}
                  </span>
                  <IconButton
                    variant="plain"
                    label="Next page"
                    title={
                      nextCursor
                        ? 'Next page'
                        : result.hits.length >= pageSize
                          ? 'Add a sort to page past 10,000 hits'
                          : 'Last page'
                    }
                    disabled={!nextCursor || st.running}
                    onClick={() => nextCursor && void run(st.page + 1, nextCursor)}
                  >
                    <ChevronRight />
                  </IconButton>
                </>
              ) : null}
            </div>
            {result && (
              <span className="shrink-0 tabular-nums">{selectedCols.length + 2} columns</span>
            )}
            <Popover open={actionsMenu} onOpenChange={setActionsMenu}>
              <PopoverTrigger asChild>
                <IconButton label="Document actions" variant="plain">
                  <MoreHorizontal />
                </IconButton>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                side="top"
                sideOffset={6}
                className="w-[240px] p-1"
                role="menu"
              >
                <MenuItem
                  icon={<Pencil />}
                  label={access.canWrite ? 'Edit document…' : 'View document…'}
                  disabled={!selectedHit}
                  onClick={() => {
                    setActionsMenu(false);
                    if (selectedHit) openHit(selectedHit);
                  }}
                />
                <MenuItem
                  icon={<FilePlus2 />}
                  label="New document…"
                  disabled={!access.canWrite || indexName.includes('*') || indexName.includes(',')}
                  onClick={() => {
                    setActionsMenu(false);
                    openDoc({ index: indexName, id: null, onDone: () => void run(0) });
                  }}
                />
                <MenuItem
                  icon={<Trash2 />}
                  label="Delete document"
                  disabled={!access.canWrite || !selectedHit}
                  onClick={() => {
                    setActionsMenu(false);
                    if (selectedHit) void deleteHit(selectedHit);
                  }}
                />
                <MenuItem
                  icon={<Trash2 />}
                  label="Delete matching documents…"
                  disabled={!access.canWrite || !result}
                  onClick={() => {
                    setActionsMenu(false);
                    void deleteMatching();
                  }}
                />
                {!access.canWrite && (
                  <div className="px-2 py-1 text-[11px] leading-snug text-[var(--wb-text-3)]">
                    {access.reason}
                  </div>
                )}
                <div className="my-1 h-px bg-[var(--wb-separator)]" />
                <MenuItem
                  icon={<Copy />}
                  label="Copy page as JSON"
                  disabled={!result || result.hits.length === 0}
                  onClick={() => {
                    setActionsMenu(false);
                    if (result) copy(hitsToJson(result.hits), `${result.hits.length} hits as JSON`);
                  }}
                />
                <MenuItem
                  icon={<Copy />}
                  label="Copy page as CSV"
                  disabled={!result || result.hits.length === 0}
                  onClick={() => {
                    setActionsMenu(false);
                    if (result)
                      copy(
                        hitsToCsv(result.hits, selectedCols),
                        `${result.hits.length} hits as CSV`,
                      );
                  }}
                />
              </PopoverContent>
            </Popover>
          </ViewFooter>
        )}
      </section>
    </main>
  );
}

function FieldPane({
  indexName,
  width,
  onResize,
  fieldFilter,
  setFieldFilter,
  fieldMenu,
  setFieldMenu,
  leaves,
  visibleFields,
  selectedCols,
  fieldStats,
  statsLoading,
  mappingError,
  loaded,
  onShowAll,
  onHideAll,
  onReset,
  onToggle,
  onLoadStats,
  onFilter,
}: {
  indexName: string;
  width: number;
  onResize: (w: number) => void;
  fieldFilter: string;
  setFieldFilter: (v: string) => void;
  fieldMenu: boolean;
  setFieldMenu: (v: boolean) => void;
  leaves: LeafField[];
  visibleFields: LeafField[];
  selectedCols: string[];
  fieldStats: Record<string, OsFieldStats>;
  statsLoading: boolean;
  mappingError: string | null;
  loaded: boolean;
  onShowAll: () => void;
  onHideAll: () => void;
  onReset: () => void;
  onToggle: (f: string) => void;
  onLoadStats: (f: string) => void;
  onFilter: (field: string, value: string) => void;
}) {
  return (
    <aside
      className="relative flex min-w-0 shrink-0 flex-col overflow-hidden border-r border-[var(--wb-separator)] bg-[var(--wb-sidebar)]"
      style={{ width }}
      aria-label="Fields"
    >
      <div className="pt-2.5">
        <SidebarSearchRow>
          <SidebarSearch
            value={fieldFilter}
            onChange={setFieldFilter}
            placeholder="Filter fields…"
            ariaLabel="Filter fields"
          />
          <Popover open={fieldMenu} onOpenChange={setFieldMenu}>
            <PopoverTrigger asChild>
              <IconButton variant="plain" label="Field options" className="[&_svg]:h-4 [&_svg]:w-4">
                <SlidersHorizontal />
              </IconButton>
            </PopoverTrigger>
            <PopoverContent align="end" sideOffset={4} className="w-[200px] p-1" role="menu">
              <MenuItem
                label="Show all columns"
                onClick={() => {
                  onShowAll();
                  setFieldMenu(false);
                }}
              />
              <MenuItem
                label="Hide all columns"
                onClick={() => {
                  onHideAll();
                  setFieldMenu(false);
                }}
              />
              <MenuItem
                label="Reset columns"
                onClick={() => {
                  onReset();
                  setFieldMenu(false);
                }}
              />
            </PopoverContent>
          </Popover>
        </SidebarSearchRow>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-2">
        {mappingError ? (
          <div className="px-4 py-3 text-[13px] text-destructive">{mappingError}</div>
        ) : !loaded ? (
          <div className="px-4 py-3 text-[13px] text-[var(--wb-text-2)]">Loading mapping…</div>
        ) : visibleFields.length === 0 ? (
          <div className="px-4 py-3 text-[13px] text-[var(--wb-text-2)]">
            {leaves.length === 0 ? 'No mapped fields' : 'No matching fields'}
          </div>
        ) : (
          <ul role="tree" aria-label={`Fields of ${indexName}`}>
            {visibleFields.map((f) => (
              <FieldRow
                key={f.path}
                field={f}
                stats={fieldStats[f.path]}
                selected={selectedCols.includes(f.path)}
                onToggle={() => onToggle(f.path)}
                onLoadStats={() => onLoadStats(f.path)}
                onFilter={(v) => onFilter(f.path, v)}
              />
            ))}
          </ul>
        )}
      </div>
      <div className="flex h-9 shrink-0 items-center gap-2 whitespace-nowrap border-t border-[var(--wb-separator)] px-3 text-[11px] text-[var(--wb-text-3)]">
        <span className="truncate tabular-nums">
          {selectedCols.length.toLocaleString()} of {leaves.length.toLocaleString()} shown
        </span>
        <div className="flex-1" />
        {statsLoading && <Loader2 className="h-3 w-3 animate-spin" aria-label="Loading stats" />}
      </div>
      {/* Resize handle (O22) */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize field list"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') onResize(Math.max(180, width - 20));
          if (e.key === 'ArrowRight') onResize(Math.min(440, width + 20));
        }}
        onPointerDown={(e) => {
          e.preventDefault();
          const startX = e.clientX;
          const start = width;
          const move = (ev: PointerEvent) =>
            onResize(Math.min(440, Math.max(180, start + ev.clientX - startX)));
          const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        }}
        className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-[var(--wb-separator)] focus-visible:bg-[var(--wb-accent)] focus-visible:outline-none"
      />
    </aside>
  );
}

function FieldRow({
  field,
  stats,
  selected,
  onToggle,
  onLoadStats,
  onFilter,
}: {
  field: LeafField;
  stats: OsFieldStats | undefined;
  selected: boolean;
  onToggle: () => void;
  onLoadStats: () => void;
  onFilter: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const expand = () => {
    setOpen((v) => {
      const next = !v;
      if (next) onLoadStats();
      return next;
    });
  };
  const maxCount = stats ? Math.max(...stats.topValues.map((v) => v.count), 1) : 1;
  const type = field.type ?? stats?.type ?? null;

  return (
    <li role="treeitem" aria-label={field.path} aria-expanded={open} aria-selected={selected}>
      <div className={cn(sidebarRowClass(false), 'gap-0.5 pl-1 pr-1.5')}>
        <button
          type="button"
          onClick={expand}
          className="grid h-5 w-4 shrink-0 place-items-center text-[var(--wb-text-3)] hover:text-[var(--wb-text)]"
          aria-label={open ? 'Collapse' : 'Expand'}
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </button>
        <button
          type="button"
          onClick={onToggle}
          className={cn(
            'grid h-5 w-5 shrink-0 place-items-center rounded-[4px] hover:text-[var(--wb-text)]',
            selected ? 'text-[var(--wb-text)]' : 'text-[var(--wb-text-3)]',
          )}
          aria-label={selected ? 'Hide column' : 'Show column'}
          aria-pressed={selected}
          title={selected ? 'Hide column' : 'Add as column'}
        >
          {selected ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          onClick={expand}
          className={cn(
            'min-w-0 flex-1 truncate pl-1 text-left',
            selected ? 'text-[var(--wb-text)]' : 'text-[var(--wb-text-2)]',
          )}
          title={field.path}
          tabIndex={-1}
        >
          {field.path}
        </button>
        {stats?.cardinality != null && (
          <span
            className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--wb-text-3)]"
            title="Distinct values (approximate)"
          >
            {stats.cardinality.toLocaleString()}
          </span>
        )}
        {type && (
          <OsBadge className="ml-1" tone={field.conflicts ? 'warn' : 'neutral'}>
            {field.conflicts ? `${type}*` : type}
          </OsBadge>
        )}
      </div>
      {open && (
        <div className="mx-2 mb-1 ml-8 mr-3 py-1">
          {field.conflicts && (
            <div className="text-[11px] text-[var(--wb-text-2)]">
              Mapped differently across indices: {field.conflicts.join(', ')}
            </div>
          )}
          {!stats ? (
            <div className="text-[11px] text-[var(--wb-text-3)]">Loading…</div>
          ) : stats.error ? (
            <div className="text-[11px] text-[var(--wb-text-3)]">{stats.error}</div>
          ) : (
            <div className="space-y-1">
              {stats.cardinality !== null && (
                <div className="font-mono text-[11px] text-[var(--wb-text-3)]">
                  cardinality ≈ {stats.cardinality.toLocaleString()}
                  {stats.aggField ? ` · via ${stats.aggField}` : ''}
                </div>
              )}
              {stats.topValues.length === 0 ? (
                <div className="text-[11px] text-[var(--wb-text-3)]">No top values</div>
              ) : (
                <ul className="space-y-0.5">
                  {stats.topValues.map((v) => (
                    <li key={v.value}>
                      <button
                        type="button"
                        onClick={() => onFilter(v.value)}
                        title={`Filter to ${field.path} = ${v.value}`}
                        className="grid w-full grid-cols-[1fr_auto] items-center gap-2 text-left font-mono text-[11px]"
                      >
                        <div className="relative h-4 overflow-hidden rounded-[3px] bg-[var(--wb-control)]">
                          <div
                            className="absolute inset-y-0 left-0 bg-[color-mix(in_srgb,var(--wb-text)_16%,transparent)]"
                            style={{ width: `${(v.count / maxCount) * 100}%` }}
                          />
                          <span className="absolute inset-y-0 left-1 flex items-center truncate pr-2 text-[var(--wb-text)]">
                            {v.value}
                          </span>
                        </div>
                        <span className="tabular-nums text-[var(--wb-text-3)]">
                          {v.count.toLocaleString()}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

const AGG_COLUMNS: DataColumn<AggRow>[] = [
  {
    key: 'path',
    label: 'Aggregation',
    width: 260,
    render: (r) => (
      <span style={{ paddingLeft: r.depth * 14 }} className="text-[var(--wb-text-2)]">
        {r.path}
      </span>
    ),
    titleOf: (r) => r.path,
  },
  {
    key: 'key',
    label: 'Key',
    width: 200,
    render: (r) => r.key,
    titleOf: (r) => r.key ?? undefined,
  },
  {
    key: 'count',
    label: 'Doc count',
    align: 'right',
    width: 110,
    render: (r) => (r.docCount === null ? null : r.docCount.toLocaleString()),
  },
  { key: 'value', label: 'Value', render: (r) => r.value, titleOf: (r) => r.value ?? undefined },
];

/** O4: aggregations as a bucket table, with the raw JSON one click away. */
function AggregationsView({ aggs }: { aggs: unknown }) {
  const [raw, setRaw] = useState(false);
  const rows = useMemo(() => flattenAggregations(aggs), [aggs]);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--wb-separator)] px-2.5 text-[12px] text-[var(--wb-text-2)]">
        <span>{rows.length.toLocaleString()} rows</span>
        <div className="flex-1" />
        <Segmented
          variant="track"
          ariaLabel="Aggregation view"
          value={raw ? 'json' : 'table'}
          onChange={(v) => setRaw(v === 'json')}
          options={[
            { value: 'table', label: 'Table' },
            { value: 'json', label: 'JSON' },
          ]}
        />
      </div>
      {raw ? (
        <JsonBody value={aggs} />
      ) : (
        <DataTable
          ariaLabel="Aggregations"
          columns={AGG_COLUMNS}
          rows={rows}
          rowKey={(r, i) => `${r.path}:${r.key}:${i}`}
          empty="No aggregation buckets"
        />
      )}
    </div>
  );
}

function jsType(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
