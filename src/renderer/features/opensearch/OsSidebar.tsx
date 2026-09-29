import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Badge } from '@/components/ui/view-parts';
import { IconButton, MenuItem } from '@/components/ui/workbench';
import {
  SidebarEmpty,
  SidebarSearch,
  SidebarSearchRow,
  sidebarRowClass,
} from '@/features/sidebar/sidebar-parts';
import { cn } from '@/lib/cn';
import { useSession } from '@/stores/session';
import {
  Loader2,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  SquareTerminal,
  Trash2,
} from 'lucide-react';
import { useMemo, useState } from 'react';

function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Compact docs count for the 11px right-aligned column (1.2k, 3.4M). */
function fmtCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

/** Cluster / index health → Badge tone. Green stays neutral (graphite). */
function healthTone(health: string): 'neutral' | 'warn' | 'danger' {
  const h = health.toLowerCase();
  if (h === 'red') return 'danger';
  if (h === 'yellow') return 'warn';
  return 'neutral';
}

/** Small health dot for 24px rows. */
function HealthDot({ health }: { health: string }) {
  const h = health.toLowerCase();
  return (
    <span
      aria-hidden
      title={`health: ${health}`}
      className={cn(
        'h-[7px] w-[7px] shrink-0 rounded-full',
        h === 'green' && 'bg-[var(--status-local)]',
        h === 'yellow' && 'bg-[var(--status-staging)]',
        h === 'red' && 'bg-destructive',
        h !== 'green' && h !== 'yellow' && h !== 'red' && 'bg-[var(--wb-text-3)]',
      )}
    />
  );
}

/** System indices are dot-prefixed (`.plugins-ml-config`, `.kibana`, …). */
function isSystemIndex(name: string): boolean {
  return name.startsWith('.');
}

/**
 * OpenSearch sidebar — Postgres-sidebar look: compact cluster meta,
 * search field + sliders menu, then a flat list of 24px index rows.
 *
 * Click an index to open its mapping/stats; double-click (or the row's
 * search action) opens a search tab against it.
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
  const [showSystem, setShowSystem] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const runAndClose = (fn: () => void) => () => {
    setMenuOpen(false);
    fn();
  };

  const systemCount = useMemo(
    () => (overview ? overview.indices.filter((i) => isSystemIndex(i.index)).length : 0),
    [overview],
  );

  const indices = useMemo(() => {
    if (!overview) return [];
    const f = filter.trim().toLowerCase();
    // Typing a leading "." is an explicit ask for system indices.
    const includeSystem = showSystem || f.startsWith('.');
    return overview.indices
      .filter((i) => includeSystem || !isSystemIndex(i.index))
      .filter((i) => !f || i.index.toLowerCase().includes(f))
      .sort((a, b) => a.index.localeCompare(b.index));
  }, [overview, filter, showSystem]);

  return (
    <div className="flex h-full flex-col bg-[var(--wb-sidebar)]">
      {/* Header — cluster meta */}
      <div className="shrink-0 px-2.5 pb-2 pt-2">
        <div className="flex h-6 items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold text-[var(--wb-text)]">
            {overview?.distribution ?? 'OpenSearch'}
          </span>
          <span className="truncate font-mono text-[11px] text-[var(--wb-text-2)]">
            {overview ? overview.version : '—'}
          </span>
          <div className="flex-1" />
          <IconButton variant="plain" label="New index" onClick={openNewIndex}>
            <Plus />
          </IconButton>
          <IconButton
            variant="plain"
            label="Refresh"
            onClick={() => void refreshOverview()}
            disabled={loading}
          >
            {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          </IconButton>
        </div>
        {overview && (
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--wb-text-3)]">
            <Badge tone={healthTone(overview.health)}>{overview.health}</Badge>
            <span className="truncate">
              {overview.nodes} {overview.nodes === 1 ? 'node' : 'nodes'} · {overview.indices.length}{' '}
              {overview.indices.length === 1 ? 'index' : 'indices'}
            </span>
          </div>
        )}
      </div>

      {/* Search + options */}
      <SidebarSearchRow>
        <SidebarSearch
          value={filter}
          onChange={setFilter}
          placeholder="Search for index…"
          ariaLabel="Filter indices"
        />
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger asChild>
            <IconButton
              variant="plain"
              label="Index options"
              active={showSystem}
              className="[&_svg]:h-4 [&_svg]:w-4"
            >
              <SlidersHorizontal />
            </IconButton>
          </PopoverTrigger>
          <PopoverContent align="end" sideOffset={4} className="w-[230px] p-1">
            <div role="menu" aria-label="Index options" className="flex flex-col">
              <MenuItem
                icon={<SquareTerminal />}
                label="Open SQL canvas"
                hint="_sql"
                onClick={runAndClose(openOsSql)}
              />
              <MenuItem icon={<Plus />} label="New index…" onClick={runAndClose(openNewIndex)} />
              <MenuItem
                icon={<RefreshCw />}
                label="Refresh"
                onClick={runAndClose(() => void refreshOverview())}
              />
              <div className="my-1 h-px bg-[var(--wb-separator)]" />
              <MenuItem
                label="Show system indices"
                hint={systemCount > 0 ? String(systemCount) : undefined}
                checked={showSystem}
                onClick={() => setShowSystem((v) => !v)}
              />
            </div>
          </PopoverContent>
        </Popover>
      </SidebarSearchRow>

      {/* Indices */}
      <div className="min-h-0 flex-1 overflow-y-auto py-1" role="tree" aria-label="Indices">
        {!overview && <SidebarEmpty title="Loading cluster…" />}
        {overview && indices.length === 0 && (
          <SidebarEmpty
            title={filter ? `No indices match "${filter}"` : 'No indices'}
            hint={
              !showSystem && systemCount > 0
                ? `${systemCount} system ${systemCount === 1 ? 'index' : 'indices'} hidden`
                : undefined
            }
          />
        )}
        {indices.map((idx) => {
          const isActive = activeIndex === idx.index;
          return (
            <div
              key={idx.index}
              role="treeitem"
              aria-level={1}
              aria-selected={isActive}
              aria-label={idx.index}
              className={cn('group/idx relative items-stretch', sidebarRowClass(isActive))}
            >
              <button
                type="button"
                onClick={() => openIndex(idx.index)}
                onDoubleClick={() => openSearch(idx.index)}
                className="flex min-w-0 flex-1 cursor-default items-center gap-2 pl-2 pr-2 text-left"
                title={`${idx.index} · ${idx.health} · ${idx.docsCount.toLocaleString()} docs · ${fmtBytes(idx.storeBytes)}`}
              >
                <HealthDot health={idx.health} />
                <span className="min-w-0 flex-1 truncate">{idx.index}</span>
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--wb-text-3)] group-focus-within/idx:invisible group-hover/idx:invisible">
                  {fmtCount(idx.docsCount)}
                </span>
              </button>
              <div className="absolute inset-y-0 right-1 hidden items-center gap-0.5 group-focus-within/idx:flex group-hover/idx:flex">
                <IconButton
                  variant="plain"
                  label={`Open search on ${idx.index}`}
                  title="Open search"
                  className="h-5 w-5"
                  onClick={(e) => {
                    e.stopPropagation();
                    openSearch(idx.index);
                  }}
                >
                  <Search />
                </IconButton>
                <IconButton
                  variant="plain"
                  label={`Delete index ${idx.index}`}
                  title="Delete index"
                  className="h-5 w-5 hover:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    requestDelete(idx.index);
                  }}
                >
                  <Trash2 />
                </IconButton>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
