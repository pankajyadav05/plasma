import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSession } from '@/stores/session';
import { Boxes, Loader2, Plus, RefreshCw, Search, SquareTerminal, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';

/**
 * Health pills are deliberately neutral. Cluster status (green/yellow/red)
 * is exposed via the textual label inside the pill — no semantic color
 * branding to keep the theme palette intact.
 */
const HEALTH_CLASS = 'bg-muted text-muted-foreground';

function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

/**
 * OpenSearch sidebar — flat indices list.
 *
 * Search filter narrows the visible set without re-fetching from the
 * cluster. Click an index to open its mapping/stats; double-click (or
 * the `+` button) to spawn a fresh search tab against it.
 */
export function OsSidebar() {
  const overview = useSession((s) => s.osOverview);
  const loading = useSession((s) => s.osLoading);
  const refreshOverview = useSession((s) => s.refreshOsOverview);
  const openIndex = useSession((s) => s.openOsIndex);
  const openSearch = useSession((s) => s.openOsSearch);
  const openOsSql = useSession((s) => s.openOsSql);
  const openNewIndex = useSession((s) => s.openOsNewIndex);
  const requestDelete = useSession((s) => s.requestOsDeleteIndex);
  const activeIndex = useSession((s) => s.activeOsIndex);

  const [filter, setFilter] = useState('');

  const indices = useMemo(() => {
    if (!overview) return [];
    if (!filter.trim()) return overview.indices;
    const f = filter.toLowerCase();
    return overview.indices.filter((i) => i.index.toLowerCase().includes(f));
  }, [overview, filter]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-sidebar-border px-3 py-2">
        <div className="flex items-center gap-2">
          <Boxes className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-sm font-semibold">OpenSearch</span>
          <span className="font-display text-[11px] italic text-muted-foreground">
            {overview ? `${overview.distribution} ${overview.version}` : '—'}
          </span>
          <div className="flex-1" />
          <Button variant="ghost" size="icon-xs" title="New index" onClick={openNewIndex}>
            <Plus />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            title="Refresh"
            onClick={() => void refreshOverview()}
          >
            {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          </Button>
        </div>
        {overview && (
          <div className="mt-1 flex flex-wrap items-center gap-2 font-display text-[11px] italic text-muted-foreground">
            <span className={`rounded-sm px-1 py-0.5 not-italic ${HEALTH_CLASS}`}>
              {overview.health}
            </span>
            <span>· {overview.nodes} node(s)</span>
            <span>· {overview.indices.length} indices</span>
          </div>
        )}
      </div>

      {/* Filter */}
      <div className="border-b border-sidebar-border px-3 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter indices…"
            className="h-7 pl-7 pr-7 font-mono text-xs"
          />
          {filter && (
            <button
              type="button"
              onClick={() => setFilter('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Clear filter"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={openOsSql}
          className="mt-2 flex w-full cursor-pointer items-center gap-2 rounded-md border border-dashed border-border px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:border-foreground hover:text-foreground"
        >
          <SquareTerminal className="h-3.5 w-3.5" />
          <span className="flex-1 text-left">Open SQL canvas</span>
          <span className="font-mono text-[10px] opacity-70">_sql</span>
        </button>
      </div>

      {/* Indices list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!overview && (
          <div className="px-4 py-3 font-display text-sm italic text-muted-foreground">
            loading cluster…
          </div>
        )}
        {overview && indices.length === 0 && (
          <div className="px-4 py-3 font-display text-sm italic text-muted-foreground">
            no indices match
          </div>
        )}
        {indices.length > 0 && (
          <ul className="py-1">
            {indices.map((idx) => {
              const isActive = activeIndex === idx.index;
              return (
                <li key={idx.index}>
                  <div
                    className={
                      isActive
                        ? 'mx-1 my-0.5 flex items-stretch rounded-md bg-sidebar-accent text-sidebar-accent-foreground'
                        : 'group/idx mx-1 my-0.5 flex items-stretch rounded-md transition-colors hover:bg-sidebar-accent/50'
                    }
                  >
                    <button
                      type="button"
                      onClick={() => openIndex(idx.index)}
                      onDoubleClick={() => openSearch(idx.index)}
                      className="flex min-w-0 flex-1 cursor-pointer flex-col items-start gap-0.5 px-2 py-1.5 text-left"
                      title={`${idx.index} · ${idx.docsCount.toLocaleString()} docs`}
                    >
                      <div className="flex w-full items-center gap-1.5">
                        <span
                          className={`shrink-0 rounded-sm px-1 py-0 font-mono text-[9px] uppercase ${HEALTH_CLASS}`}
                        >
                          {idx.health}
                        </span>
                        <span className="truncate font-mono text-xs">{idx.index}</span>
                      </div>
                      <div className="font-display text-[10px] italic text-muted-foreground">
                        {idx.docsCount.toLocaleString()} docs · {fmtBytes(idx.storeBytes)}
                      </div>
                    </button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={(e) => {
                        e.stopPropagation();
                        openSearch(idx.index);
                      }}
                      className="self-center opacity-0 transition-opacity group-hover/idx:opacity-100"
                      title="Open search"
                    >
                      <Search />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={(e) => {
                        e.stopPropagation();
                        requestDelete(idx.index);
                      }}
                      className="mr-1 self-center opacity-0 transition-opacity hover:text-destructive group-hover/idx:opacity-100"
                      title="Delete index"
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
