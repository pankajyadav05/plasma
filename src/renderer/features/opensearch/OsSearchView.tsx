import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import type { OsFieldStats, OsHit, OsSearchResult } from '@shared/protocol';
import {
  ChevronDown,
  ChevronRight,
  Code2,
  Eye,
  EyeOff,
  Loader2,
  Play,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

const PAGE_SIZE = 50;

type ViewMode = 'discover' | 'dsl';

/**
 * OpenSearch Discover-style canvas.
 *
 * Layout:
 *   - Top: query string bar (Lucene/KQL-ish) + Run + view toggle
 *   - Left rail: field list with cardinality + top values
 *   - Right: hits table (rows = selected fields as columns) with JSON
 *     drawer on click
 *
 * The "DSL" toggle drops in a textarea-only mode for power users
 * (replacing the query bar with raw JSON body input). Both modes share
 * the same hits panel below.
 */
export function OsSearchView({
  tabId,
  indexName,
}: {
  tabId: string;
  indexName: string;
}) {
  const tabs = useSession((s) => s.tabs);
  const tab = tabs.find((t) => t.id === tabId);

  const [view, setView] = useState<ViewMode>('discover');
  const [queryString, setQueryString] = useState(tab?.osQueryString ?? '');
  const [body, setBody] = useState(
    tab?.osBody ?? '{\n  "query": { "match_all": {} },\n  "size": 50\n}\n',
  );
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OsSearchResult | null>(null);

  const [allFields, setAllFields] = useState<string[]>([]);
  const [selectedCols, setSelectedCols] = useState<string[]>([]);
  const [fieldStats, setFieldStats] = useState<Record<string, OsFieldStats>>({});
  const [statsLoading, setStatsLoading] = useState(false);

  const persist = (patch: { osQueryString?: string; osBody?: string }) => {
    useSession.setState((state) => ({
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)),
    }));
  };

  // Load top-level fields from mapping on mount, then run a default search.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const root = await ipc.os.mapping(indexName);
        if (cancelled) return;
        const tops = root.children.map((c) => c.name).sort();
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
    (size = PAGE_SIZE) => {
      if (view === 'dsl') return body;
      const trimmed = queryString.trim();
      const obj: Record<string, unknown> = { size };
      obj.query = trimmed ? { query_string: { query: trimmed } } : { match_all: {} };
      return JSON.stringify(obj, null, 2);
    },
    [view, body, queryString],
  );

  const onRun = async () => {
    setRunning(true);
    setError(null);
    try {
      const r = await ipc.os.search({
        index: indexName,
        body: buildBody(PAGE_SIZE),
        size: PAGE_SIZE,
      });
      setResult(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  // Keyboard: ⌘⏎ runs from anywhere inside the canvas.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void onRun();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
    // biome-ignore lint/correctness/useExhaustiveDependencies: onRun captures
    // queryString/body/view via closure; rebinding on every keystroke is wasteful.
  }, [view, queryString, body, indexName]);

  // Lazy-load stats for visible fields when the field rail is expanded.
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
  useEffect(() => {
    if (allFields.length === 0) return;
    void loadStats(allFields.slice(0, 10));
    // biome-ignore lint/correctness/useExhaustiveDependencies: only when the
    // mapping arrives; downstream loadStats invocations come from the row UI.
  }, [allFields]);

  const toggleColumn = (field: string) => {
    setSelectedCols((prev) =>
      prev.includes(field) ? prev.filter((f) => f !== field) : [...prev, field],
    );
  };

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {/* Top bar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="font-mono text-xs text-muted-foreground">{indexName}</span>
        <div className="flex-1" />
        {result && (
          <span className="font-display text-[11px] italic text-muted-foreground">
            {result.total.toLocaleString()} hits · {result.took}ms
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setView(view === 'discover' ? 'dsl' : 'discover')}
          title="Toggle DSL editor"
        >
          <Code2 />
          {view === 'discover' ? 'DSL' : 'Discover'}
        </Button>
        <Button variant="primary" size="sm" onClick={() => void onRun()} disabled={running}>
          {running ? <Loader2 className="animate-spin" /> : <Play className="fill-current" />}
          Run
        </Button>
      </div>

      {/* Query bar / DSL editor */}
      <div className="shrink-0 border-b border-border bg-muted/30 px-4 py-2">
        {view === 'discover' ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void onRun();
            }}
          >
            <Input
              value={queryString}
              onChange={(e) => {
                setQueryString(e.target.value);
                persist({ osQueryString: e.target.value });
              }}
              placeholder="status:200 AND user.id:* — query_string syntax (Enter to run)"
              className="h-8 font-mono text-xs"
            />
          </form>
        ) : (
          <textarea
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              persist({ osBody: e.target.value });
            }}
            spellCheck={false}
            rows={10}
            className="w-full resize-y rounded-md border border-input bg-background p-2 font-mono text-xs leading-5 outline-none focus:border-primary"
            placeholder='{"query": {"match_all": {}}, "size": 50}'
          />
        )}
      </div>

      {/* Body */}
      <div className="grid min-h-0 flex-1 grid-cols-[260px_1fr]">
        {/* Field rail */}
        <aside className="flex min-h-0 flex-col border-r border-border bg-muted/20">
          <div className="shrink-0 border-b border-border px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            fields
            {statsLoading && (
              <Loader2 className="ml-2 inline-block h-3 w-3 animate-spin" />
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {allFields.length === 0 && (
              <div className="px-3 py-2 font-display text-xs italic text-muted-foreground">
                loading mapping…
              </div>
            )}
            <ul>
              {allFields.map((f) => (
                <FieldRow
                  key={f}
                  field={f}
                  stats={fieldStats[f]}
                  selected={selectedCols.includes(f)}
                  onToggle={() => toggleColumn(f)}
                  onLoadStats={() => {
                    if (!fieldStats[f]) void loadStats([f]);
                  }}
                />
              ))}
            </ul>
          </div>
        </aside>

        {/* Hits panel */}
        <div className="flex min-h-0 flex-col">
          <div className="min-h-0 flex-1 overflow-auto">
            {error && (
              <div className="m-3 rounded-md border-l-4 border-destructive bg-muted px-4 py-2 text-sm text-foreground">
                {error}
              </div>
            )}
            {!error && result && (
              <HitsTable result={result} selectedCols={selectedCols} />
            )}
            {!error && !result && (
              <div className="px-4 py-3 font-display text-sm italic text-muted-foreground">
                {running ? 'searching…' : 'press Run to execute'}
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

function FieldRow({
  field,
  stats,
  selected,
  onToggle,
  onLoadStats,
}: {
  field: string;
  stats: OsFieldStats | undefined;
  selected: boolean;
  onToggle: () => void;
  onLoadStats: () => void;
}) {
  const [open, setOpen] = useState(false);
  const expand = useMemo(
    () => () => {
      setOpen((v) => {
        const next = !v;
        if (next) onLoadStats();
        return next;
      });
    },
    [onLoadStats],
  );

  return (
    <li className="border-b border-border/30 last:border-b-0">
      <div className="flex items-center gap-1 px-2 py-1 text-xs">
        <button
          type="button"
          onClick={expand}
          className="grid h-5 w-5 cursor-pointer place-items-center text-muted-foreground hover:text-foreground"
          aria-label={open ? 'Collapse' : 'Expand'}
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </button>
        <button
          type="button"
          onClick={onToggle}
          className="grid h-5 w-5 cursor-pointer place-items-center text-muted-foreground hover:text-foreground"
          aria-label={selected ? 'Hide column' : 'Show column'}
          title={selected ? 'Hide column' : 'Add as column'}
        >
          {selected ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
        </button>
        <span className="flex-1 truncate font-mono text-foreground" title={field}>
          {field}
        </span>
        {stats?.type && (
          <span className="shrink-0 rounded-sm bg-muted px-1 text-[9px] uppercase tracking-wider text-muted-foreground">
            {stats.type}
          </span>
        )}
      </div>
      {open && (
        <div className="border-t border-border/30 bg-background px-3 py-2">
          {!stats ? (
            <div className="font-display text-[11px] italic text-muted-foreground">
              loading…
            </div>
          ) : (
            <div className="space-y-1">
              {stats.cardinality !== null && (
                <div className="font-mono text-[11px] text-muted-foreground">
                  cardinality ≈ {stats.cardinality.toLocaleString()}
                </div>
              )}
              {stats.topValues.length === 0 ? (
                <div className="font-display text-[11px] italic text-muted-foreground">
                  no terms agg results
                </div>
              ) : (
                <ul className="space-y-0.5">
                  {stats.topValues.map((v) => {
                    const max = Math.max(
                      ...stats.topValues.map((vv) => vv.count),
                      1,
                    );
                    const pct = (v.count / max) * 100;
                    return (
                      <li
                        key={v.value}
                        className="grid grid-cols-[1fr_auto] items-center gap-2 font-mono text-[11px]"
                      >
                        <div className="relative h-3 overflow-hidden rounded-sm bg-muted">
                          <div
                            className="absolute inset-y-0 left-0 bg-foreground/40"
                            style={{ width: `${pct}%` }}
                          />
                          <span className="absolute inset-y-0 left-1 flex items-center truncate pr-2 text-foreground">
                            {v.value}
                          </span>
                        </div>
                        <span className="text-muted-foreground">
                          {v.count.toLocaleString()}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function HitsTable({
  result,
  selectedCols,
}: {
  result: OsSearchResult;
  selectedCols: string[];
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (result.hits.length === 0) {
    return (
      <div className="px-4 py-3 font-display text-sm italic text-muted-foreground">
        no hits
      </div>
    );
  }
  const cols = selectedCols.length > 0 ? selectedCols : result.fields.slice(0, 5);
  return (
    <table className="w-full font-mono text-xs">
      <thead className="sticky top-0 z-10 bg-muted/80 text-[10px] uppercase tracking-wider text-muted-foreground backdrop-blur">
        <tr>
          <th className="border-b border-border px-3 py-1.5 text-left">_id</th>
          <th className="border-b border-border px-3 py-1.5 text-right">_score</th>
          {cols.map((c) => (
            <th key={c} className="border-b border-border px-3 py-1.5 text-left">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {result.hits.map((h) => {
          const src = (h.source ?? {}) as Record<string, unknown>;
          const isOpen = openId === h.id;
          return (
            <HitRow
              key={h.id}
              hit={h}
              src={src}
              cols={cols}
              isOpen={isOpen}
              onToggle={() => setOpenId(isOpen ? null : h.id)}
            />
          );
        })}
      </tbody>
    </table>
  );
}

function HitRow({
  hit,
  src,
  cols,
  isOpen,
  onToggle,
}: {
  hit: OsHit;
  src: Record<string, unknown>;
  cols: string[];
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        tabIndex={0}
        className="cursor-pointer border-b border-border/50 hover:bg-muted/30 focus-visible:bg-muted/50 focus-visible:outline-none"
      >
        <td className="break-all px-3 py-1 align-top text-foreground">{hit.id}</td>
        <td className="px-3 py-1 text-right align-top text-muted-foreground">
          {hit.score === null ? '—' : hit.score.toFixed(2)}
        </td>
        {cols.map((c) => (
          <td key={c} className="break-all px-3 py-1 align-top text-foreground">
            {renderCell(src[c])}
          </td>
        ))}
      </tr>
      {isOpen && (
        <tr className="border-b border-border bg-muted/20">
          <td colSpan={2 + cols.length} className="px-3 py-2">
            <pre className="overflow-auto rounded-md border border-border bg-background p-3 font-mono text-[11px] leading-5">
              {JSON.stringify(hit.source, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}

function renderCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
