import { type DataColumn, DataTable } from '@/components/ui/data-table';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Badge, EmptyState, ViewFooter } from '@/components/ui/view-parts';
import { IconButton, MenuItem, Pill, Segmented } from '@/components/ui/workbench';
import { SidebarSearch, SidebarSearchRow, sidebarRowClass } from '@/features/sidebar/sidebar-parts';
import { cn } from '@/lib/cn';
import { ipc } from '@/lib/ipc';
import { kbd } from '@/lib/platform';
import { useSession } from '@/stores/session';
import { useWorkbench } from '@/stores/workbench';
import type { OsFieldStats, OsHit, OsSearchResult } from '@shared/protocol';
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Loader2,
  Search,
  SlidersHorizontal,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type CaretInfo,
  CodeArea,
  EditorBar,
  JsonBody,
  QueryErrorPanel,
  RunPill,
  RunningState,
  caretText,
  cellText,
  clearInspected,
  formatMs,
} from './OsSqlView';

const PAGE_SIZE = 50;
const SIZE_CHOICES = [20, 50, 100, 500, 1000] as const;

type ViewMode = 'discover' | 'dsl';
type ResultMode = 'data' | 'json';

/**
 * OpenSearch Discover-style canvas, laid out like the Postgres SQL tab.
 *
 *   - Left: field list (Postgres-sidebar rows) with type badges,
 *     column visibility toggles, cardinality + top values on expand.
 *   - Right: query-string field (or the DSL editor) → editor footer
 *     (hint, `Query | DSL`, size, neutral Run) → hits grid → footer
 *     (`Data | JSON`, took, hit count).
 *
 * Selecting a hit publishes the whole flattened document to the right
 * sidebar's Details pane.
 */
export function OsSearchView({ tabId, indexName }: { tabId: string; indexName: string }) {
  // Keyed so two search tabs never share query/result state.
  return <OsSearchViewInner key={`${tabId}:${indexName}`} tabId={tabId} indexName={indexName} />;
}

function OsSearchViewInner({ tabId, indexName }: { tabId: string; indexName: string }) {
  const tabs = useSession((s) => s.tabs);
  const tab = tabs.find((t) => t.id === tabId);

  const [view, setView] = useState<ViewMode>('discover');
  const [queryString, setQueryString] = useState(tab?.osQueryString ?? '');
  const [body, setBody] = useState(
    tab?.osBody ?? '{\n  "query": { "match_all": {} },\n  "size": 50\n}\n',
  );
  const [size, setSize] = useState<number>(PAGE_SIZE);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OsSearchResult | null>(null);
  const [caret, setCaret] = useState<CaretInfo | null>(null);
  const [mode, setMode] = useState<ResultMode>('data');
  const [selected, setSelected] = useState<number | null>(null);

  const [allFields, setAllFields] = useState<string[]>([]);
  const [fieldTypes, setFieldTypes] = useState<Record<string, string>>({});
  const [selectedCols, setSelectedCols] = useState<string[]>([]);
  const [fieldStats, setFieldStats] = useState<Record<string, OsFieldStats>>({});
  const [statsLoading, setStatsLoading] = useState(false);
  const [fieldFilter, setFieldFilter] = useState('');
  const [fieldMenu, setFieldMenu] = useState(false);
  const [sizeMenu, setSizeMenu] = useState(false);

  const persist = (patch: { osQueryString?: string; osBody?: string }) => {
    useSession.setState((state) => ({
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)),
    }));
  };

  // Load top-level fields from mapping on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const root = await ipc.os.mapping(indexName);
        if (cancelled) return;
        const tops = root.children.map((c) => c.name).sort();
        const types: Record<string, string> = {};
        for (const c of root.children) {
          const t = c.type ?? (c.children.length > 0 ? 'object' : null);
          if (t) types[c.name] = t;
        }
        setFieldTypes(types);
        setAllFields(tops);
        // Pick a sensible default column set — first 5 fields.
        setSelectedCols(tops.slice(0, 5));
      } catch (err) {
        console.error('[plasma-os] mapping fetch failed', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [indexName]);

  const buildBody = useCallback(
    (n = PAGE_SIZE) => {
      if (view === 'dsl') return body;
      const trimmed = queryString.trim();
      const obj: Record<string, unknown> = { size: n };
      obj.query = trimmed ? { query_string: { query: trimmed } } : { match_all: {} };
      return JSON.stringify(obj, null, 2);
    },
    [view, body, queryString],
  );

  const onRun = async () => {
    setRunning(true);
    setError(null);
    setSelected(null);
    clearInspected(tabId);
    try {
      const r = await ipc.os.search({
        index: indexName,
        body: buildBody(size),
        size,
      });
      setResult(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  // Keyboard: ⌘⏎ runs from anywhere; the ref always holds the latest closure.
  const runRef = useRef(onRun);
  runRef.current = onRun;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void runRef.current();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // Drop this tab's row from the Details sidebar when the view goes away.
  useEffect(() => () => clearInspected(tabId), [tabId]);

  // Lazy-load stats for fields (on first load and when a row is expanded).
  const loadStats = useCallback(
    async (fields: string[]) => {
      if (fields.length === 0) return;
      setStatsLoading(true);
      try {
        const stats = await ipc.os.fieldStats({
          index: indexName,
          fields,
          queryString: queryString || undefined,
        });
        setFieldStats((prev) => {
          const next = { ...prev };
          for (const s of stats) next[s.field] = s;
          return next;
        });
      } catch (err) {
        console.error('[plasma-os] fieldStats failed', err);
      } finally {
        setStatsLoading(false);
      }
    },
    [indexName, queryString],
  );

  // First load: stats for top 10 fields. Cheap and gives the field
  // sidebar useful counts without waiting for user interaction.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the mapping arrives; downstream loadStats invocations come from the row UI.
  useEffect(() => {
    if (allFields.length === 0) return;
    void loadStats(allFields.slice(0, 10));
  }, [allFields]);

  const toggleColumn = (field: string) => {
    setSelectedCols((prev) =>
      prev.includes(field) ? prev.filter((f) => f !== field) : [...prev, field],
    );
  };

  const visibleFields = useMemo(() => {
    const q = fieldFilter.trim().toLowerCase();
    return q ? allFields.filter((f) => f.toLowerCase().includes(q)) : allFields;
  }, [allFields, fieldFilter]);

  const cols = useMemo(
    () => (selectedCols.length > 0 ? selectedCols : (result?.fields.slice(0, 5) ?? [])),
    [selectedCols, result],
  );

  const columns = useMemo<DataColumn<OsHit>[]>(
    () => [
      {
        key: '_id',
        label: '_id',
        title: '_id — document id',
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
      ...cols.map<DataColumn<OsHit>>((c) => ({
        key: `f:${c}`,
        label: c,
        title: fieldTypes[c] ? `${c} — ${fieldTypes[c]}` : c,
        render: (h) => cellText(sourceOf(h)[c]),
        titleOf: (h) => cellText(sourceOf(h)[c]) ?? undefined,
      })),
    ],
    [cols, fieldTypes],
  );

  const onSelectHit = (hit: OsHit, index: number) => {
    setSelected(index);
    const flat = flatten(sourceOf(hit));
    const entries = Object.entries(flat);
    useWorkbench.getState().setInspectedRow({
      tabId,
      rowNumber: index + 1,
      columnIndex: 0,
      columns: [
        { name: '_id', dataTypeID: 0, dataTypeName: 'id' },
        { name: '_index', dataTypeID: 0, dataTypeName: 'index' },
        { name: '_score', dataTypeID: 0, dataTypeName: 'score' },
        ...entries.map(([name, value]) => ({
          name,
          dataTypeID: 0,
          dataTypeName: fieldTypes[name] ?? jsType(value),
        })),
      ],
      row: [hit.id, hit.index, hit.score, ...entries.map(([, v]) => v)],
    });
  };

  const hitCount = result?.hits.length ?? 0;

  return (
    <main className="flex min-h-0 min-w-0 flex-1 bg-[var(--wb-content)]">
      {/* Field list — Postgres sidebar look */}
      <aside
        className="flex w-[240px] shrink-0 flex-col border-r border-[var(--wb-separator)] bg-[var(--wb-sidebar)]"
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
                <IconButton
                  variant="plain"
                  label="Field options"
                  className="[&_svg]:h-4 [&_svg]:w-4"
                >
                  <SlidersHorizontal />
                </IconButton>
              </PopoverTrigger>
              <PopoverContent align="end" sideOffset={4} className="w-[200px] p-1" role="menu">
                <MenuItem
                  label="Show all columns"
                  onClick={() => {
                    setSelectedCols(allFields);
                    setFieldMenu(false);
                  }}
                />
                <MenuItem
                  label="Hide all columns"
                  onClick={() => {
                    setSelectedCols([]);
                    setFieldMenu(false);
                  }}
                />
                <MenuItem
                  label="Reset columns"
                  onClick={() => {
                    setSelectedCols(allFields.slice(0, 5));
                    setFieldMenu(false);
                  }}
                />
              </PopoverContent>
            </Popover>
          </SidebarSearchRow>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          {allFields.length === 0 ? (
            <div className="px-4 py-3 text-[13px] text-[var(--wb-text-2)]">Loading mapping…</div>
          ) : visibleFields.length === 0 ? (
            <div className="px-4 py-3 text-[13px] text-[var(--wb-text-2)]">No matching fields</div>
          ) : (
            <ul role="tree" aria-label={`Fields of ${indexName}`}>
              {visibleFields.map((f) => (
                <FieldRow
                  key={f}
                  field={f}
                  type={fieldTypes[f] ?? fieldStats[f]?.type ?? null}
                  stats={fieldStats[f]}
                  selected={selectedCols.includes(f)}
                  onToggle={() => toggleColumn(f)}
                  onLoadStats={() => {
                    if (!fieldStats[f]) void loadStats([f]);
                  }}
                />
              ))}
            </ul>
          )}
        </div>
        <div className="flex h-9 shrink-0 items-center gap-2 border-t border-[var(--wb-separator)] px-3 text-[11px] text-[var(--wb-text-3)]">
          <span className="tabular-nums">
            {selectedCols.length.toLocaleString()} of {allFields.length.toLocaleString()} shown
          </span>
          <div className="flex-1" />
          {statsLoading && <Loader2 className="h-3 w-3 animate-spin" aria-label="Loading stats" />}
        </div>
      </aside>

      {/* Query + hits */}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {view === 'discover' ? (
          <form
            className="shrink-0 bg-[var(--wb-content)] px-2.5 py-2"
            onSubmit={(e) => {
              e.preventDefault();
              void onRun();
            }}
          >
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--wb-text-2)]" />
              <input
                type="text"
                value={queryString}
                onChange={(e) => {
                  setQueryString(e.target.value);
                  persist({ osQueryString: e.target.value });
                }}
                aria-label="Query string"
                spellCheck={false}
                placeholder="status:200 AND user.id:* — query_string syntax (Enter to run)"
                className="h-7 w-full rounded-[7px] border-0 bg-[var(--wb-field)] pl-7 pr-2 font-mono text-[13px] text-[var(--wb-text)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--wb-text)_8%,transparent)] outline-none transition-shadow placeholder:text-[var(--wb-text-3)] focus:shadow-[0_0_0_2px_color-mix(in_srgb,var(--wb-accent)_55%,transparent)]"
              />
            </div>
          </form>
        ) : (
          <CodeArea
            value={body}
            onChange={(v) => {
              setBody(v);
              persist({ osBody: v });
            }}
            onCaret={setCaret}
            placeholder='{"query": {"match_all": {}}, "size": 50}'
            ariaLabel="Query DSL"
            className="h-[220px] shrink-0"
          />
        )}

        <EditorBar
          hint={
            view === 'dsl'
              ? caret
                ? caretText(caret)
                : `${indexName} · POST /_search`
              : `${indexName} · query_string — Enter to run`
          }
          right={
            <>
              <Segmented
                variant="track"
                ariaLabel="Query mode"
                value={view}
                onChange={setView}
                options={[
                  { value: 'discover', label: 'Query', title: 'query_string search' },
                  { value: 'dsl', label: 'DSL', title: 'Toggle DSL editor' },
                ]}
              />
              <Popover open={sizeMenu} onOpenChange={setSizeMenu}>
                <PopoverTrigger asChild>
                  <Pill title="Documents per search — a DSL body with its own size wins">
                    {size.toLocaleString()} hits
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
                      label={`${n.toLocaleString()} hits`}
                      checked={size === n}
                      onClick={() => {
                        setSize(n);
                        setSizeMenu(false);
                      }}
                    />
                  ))}
                </PopoverContent>
              </Popover>
              <RunPill running={running} onRun={() => void onRun()} />
            </>
          }
        />

        <div className="flex min-h-0 flex-1 flex-col border-t border-[var(--wb-separator)]">
          {error ? (
            <QueryErrorPanel message={error} />
          ) : running && !result ? (
            <RunningState label="Searching…" />
          ) : !result ? (
            <EmptyState
              title="No results"
              hint={`Press Run (${kbd('⏎')}) to search ${indexName}.`}
            />
          ) : result.hits.length === 0 ? (
            <EmptyState title="No hits" hint="Nothing in this index matched the query." />
          ) : mode === 'json' ? (
            <JsonBody
              value={result.hits.map((h) => ({
                _index: h.index,
                _id: h.id,
                _score: h.score,
                _source: h.source,
              }))}
            />
          ) : (
            <DataTable
              ariaLabel="Search hits"
              columns={columns}
              rows={result.hits}
              rowKey={(h, i) => `${h.index}/${h.id}/${i}`}
              selectedIndex={selected}
              onSelect={onSelectHit}
            />
          )}
        </div>

        {result && !error && (
          <ViewFooter>
            <Segmented
              variant="track"
              ariaLabel="Result view"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'data', label: 'Data' },
                { value: 'json', label: 'JSON' },
              ]}
            />
            <span className="tabular-nums">{formatMs(result.took)}</span>
            <div className="flex flex-1 justify-center tabular-nums">
              {hitCount.toLocaleString()} of {result.total.toLocaleString()}{' '}
              {result.total === 1 ? 'hit' : 'hits'}
            </div>
            <span className="tabular-nums">
              {cols.length + 2} {cols.length + 2 === 1 ? 'column' : 'columns'}
            </span>
          </ViewFooter>
        )}
      </section>
    </main>
  );
}

function FieldRow({
  field,
  type,
  stats,
  selected,
  onToggle,
  onLoadStats,
}: {
  field: string;
  type: string | null;
  stats: OsFieldStats | undefined;
  selected: boolean;
  onToggle: () => void;
  onLoadStats: () => void;
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

  return (
    <li role="treeitem" aria-label={field} aria-expanded={open} aria-selected={selected}>
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
          title={field}
          tabIndex={-1}
        >
          {field}
        </button>
        {stats?.cardinality != null && (
          <span
            className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--wb-text-3)]"
            title="Distinct values (approximate)"
          >
            {stats.cardinality.toLocaleString()}
          </span>
        )}
        {type && <Badge className="ml-1">{type}</Badge>}
      </div>
      {open && (
        <div className="mx-2 mb-1 ml-8 mr-3 py-1">
          {!stats ? (
            <div className="text-[11px] text-[var(--wb-text-3)]">Loading…</div>
          ) : (
            <div className="space-y-1">
              {stats.cardinality !== null && (
                <div className="font-mono text-[11px] text-[var(--wb-text-3)]">
                  cardinality ≈ {stats.cardinality.toLocaleString()}
                </div>
              )}
              {stats.topValues.length === 0 ? (
                <div className="text-[11px] text-[var(--wb-text-3)]">No top values</div>
              ) : (
                <ul className="space-y-0.5">
                  {stats.topValues.map((v) => (
                    <li
                      key={v.value}
                      className="grid grid-cols-[1fr_auto] items-center gap-2 font-mono text-[11px]"
                    >
                      <div className="relative h-4 overflow-hidden rounded-[3px] bg-[var(--wb-control)]">
                        <div
                          className="absolute inset-y-0 left-0 bg-[color-mix(in_srgb,var(--wb-text)_16%,transparent)]"
                          style={{ width: `${(v.count / maxCount) * 100}%` }}
                        />
                        <span
                          className="absolute inset-y-0 left-1 flex items-center truncate pr-2 text-[var(--wb-text)]"
                          title={v.value}
                        >
                          {v.value}
                        </span>
                      </div>
                      <span className="tabular-nums text-[var(--wb-text-3)]">
                        {v.count.toLocaleString()}
                      </span>
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

function sourceOf(hit: OsHit): Record<string, unknown> {
  const s = hit.source;
  return s && typeof s === 'object' && !Array.isArray(s) ? (s as Record<string, unknown>) : {};
}

/** Dotted-path flattening of plain objects; arrays and scalars stay as leaf values. */
function flatten(obj: Record<string, unknown>, prefix = '', out: Record<string, unknown> = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0) {
      flatten(v as Record<string, unknown>, key, out);
    } else {
      out[key] = v;
    }
  }
  return out;
}

function jsType(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
