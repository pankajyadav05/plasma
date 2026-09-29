import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { IconButton, MenuItem } from '@/components/ui/workbench';
import {
  SidebarEmpty,
  SidebarSearch,
  SidebarSearchRow,
  sidebarRowClass,
} from '@/features/sidebar/sidebar-parts';
import { cn } from '@/lib/cn';
import { useSession } from '@/stores/session';
import type { OsIndex } from '@shared/protocol';
import {
  ChevronDown,
  ChevronRight,
  Layers,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  SquareTerminal,
  Terminal,
  Trash2,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import {
  type IndexGroup,
  capitalise,
  fmtBytes,
  fmtCount,
  groupIndices,
  healthTone,
} from './os-format';
import { OsBadge } from './os-parts';
import { useOsWriteAccess } from './os-write';

const ROW_H = 24;
/** Rows rendered above/below the viewport when windowing (O24). */
const OVERSCAN = 12;

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

type Item =
  | { kind: 'index'; index: OsIndex; depth: number }
  | { kind: 'group'; group: IndexGroup; docs: number; open: boolean };

/**
 * OpenSearch sidebar — Postgres-sidebar look: compact cluster meta,
 * search field + sliders menu, then 24px index rows. Rolling indices
 * (date-suffixed, rollover counters, data-stream backing indices) fold
 * into one expandable group, and long lists are windowed (O24).
 *
 * Click an index to open its mapping/stats; the row's search action
 * opens a search tab against it (O11: no double-click double tab).
 */
export function OsSidebar() {
  const overview = useSession((s) => s.osOverview);
  const loading = useSession((s) => s.osLoading);
  const refreshOverview = useSession((s) => s.refreshOsOverview);
  const openIndex = useSession((s) => s.openOsIndex);
  const openSearch = useSession((s) => s.openOsSearch);
  const openOsSql = useSession((s) => s.openOsSql);
  const openOsConsole = useSession((s) => s.openOsConsole);
  const openNewIndex = useSession((s) => s.openOsNewIndex);
  const requestDelete = useSession((s) => s.requestOsDeleteIndex);
  const activeIndex = useSession((s) => s.activeOsIndex);
  const access = useOsWriteAccess();

  const [filter, setFilter] = useState('');
  const [showSystem, setShowSystem] = useState(false);
  const [grouping, setGrouping] = useState(true);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);
  const listRef = useRef<HTMLDivElement | null>(null);
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

  const items = useMemo<Item[]>(() => {
    const byName = new Map(indices.map((i) => [i.index, i]));
    if (!grouping) return indices.map((index) => ({ kind: 'index', index, depth: 0 }));
    const out: Item[] = [];
    for (const entry of groupIndices(indices.map((i) => i.index))) {
      if (typeof entry === 'string') {
        const index = byName.get(entry);
        if (index) out.push({ kind: 'index', index, depth: 0 });
        continue;
      }
      // An active filter expands groups so matches are visible.
      const open = openGroups.has(entry.name) || filter.trim().length > 0;
      const docs = entry.members.reduce((n, m) => n + (byName.get(m)?.docsCount ?? 0), 0);
      out.push({ kind: 'group', group: entry, docs, open });
      if (open) {
        for (const m of entry.members) {
          const index = byName.get(m);
          if (index) out.push({ kind: 'index', index, depth: 1 });
        }
      }
    }
    return out;
  }, [indices, grouping, openGroups, filter]);

  const toggleGroup = (name: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  // Window the list: only rows near the viewport are in the DOM.
  const windowed = items.length > 200;
  const start = windowed ? Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN) : 0;
  const end = windowed
    ? Math.min(items.length, Math.ceil((scrollTop + viewport) / ROW_H) + OVERSCAN)
    : items.length;
  const visible = items.slice(start, end);

  const pattern = filter.trim() && indices.length > 1 ? `*${filter.trim()}*` : null;

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-[var(--wb-sidebar)]">
      {/* Header — cluster meta */}
      <div className="shrink-0 px-2.5 pb-2 pt-2">
        <div className="flex h-6 min-w-0 items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold text-[var(--wb-text)]">
            {overview ? capitalise(overview.distribution) : 'OpenSearch'}
          </span>
          <span className="truncate font-mono text-[11px] text-[var(--wb-text-2)]">
            {overview ? overview.version : '—'}
          </span>
          <div className="flex-1" />
          <IconButton
            variant="plain"
            label="New index"
            title={access.reason ?? 'New index'}
            onClick={openNewIndex}
            disabled={!access.canWrite}
          >
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
            <OsBadge tone={healthTone(overview.health)}>{overview.health}</OsBadge>
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
          onChange={(v) => {
            setFilter(v);
            if (listRef.current) listRef.current.scrollTop = 0;
            setScrollTop(0);
          }}
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
          <PopoverContent align="end" sideOffset={4} className="w-[240px] p-1">
            <div role="menu" aria-label="Index options" className="flex flex-col">
              {pattern && (
                <MenuItem
                  icon={<Search />}
                  label={`Search ${pattern}`}
                  hint={String(indices.length)}
                  onClick={runAndClose(() => openSearch(pattern))}
                />
              )}
              <MenuItem
                icon={<SquareTerminal />}
                label="Open SQL canvas"
                hint="_sql"
                onClick={runAndClose(openOsSql)}
              />
              <MenuItem
                icon={<Terminal />}
                label="Open console"
                hint="REST"
                onClick={runAndClose(openOsConsole)}
              />
              <MenuItem
                icon={<Plus />}
                label="New index…"
                disabled={!access.canWrite}
                onClick={runAndClose(openNewIndex)}
              />
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
              <MenuItem
                label="Group rolling indices"
                checked={grouping}
                onClick={() => setGrouping((v) => !v)}
              />
            </div>
          </PopoverContent>
        </Popover>
      </SidebarSearchRow>

      {/* Indices */}
      <div
        ref={(el) => {
          listRef.current = el;
          if (el?.clientHeight && el.clientHeight !== viewport) setViewport(el.clientHeight);
        }}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1"
        role="tree"
        aria-label="Indices"
      >
        {!overview && <SidebarEmpty title="Loading cluster…" />}
        {overview && items.length === 0 && (
          <SidebarEmpty
            title={filter ? `No indices match "${filter}"` : 'No indices'}
            hint={
              !showSystem && systemCount > 0
                ? `${systemCount} system ${systemCount === 1 ? 'index' : 'indices'} hidden`
                : undefined
            }
          />
        )}
        {windowed && <div style={{ height: start * ROW_H }} aria-hidden />}
        {visible.map((item) =>
          item.kind === 'group' ? (
            <div
              key={`g:${item.group.name}`}
              role="treeitem"
              aria-level={1}
              aria-expanded={item.open}
              aria-selected={false}
              aria-label={`${item.group.name} (${item.group.members.length} indices)`}
              className={cn('relative', sidebarRowClass(false))}
            >
              <button
                type="button"
                onClick={() => toggleGroup(item.group.name)}
                className="flex min-w-0 flex-1 cursor-default items-center gap-1.5 pl-1 pr-2 text-left"
                title={`${item.group.members.length} indices`}
              >
                {item.open ? (
                  <ChevronDown className="h-3 w-3 shrink-0 text-[var(--wb-text-3)]" />
                ) : (
                  <ChevronRight className="h-3 w-3 shrink-0 text-[var(--wb-text-3)]" />
                )}
                <Layers className="h-3.5 w-3.5 shrink-0 text-[var(--wb-text-2)]" />
                <span className="min-w-0 flex-1 truncate">{item.group.name}</span>
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--wb-text-3)]">
                  {item.group.members.length} · {fmtCount(item.docs)}
                </span>
              </button>
            </div>
          ) : (
            <IndexRow
              key={item.index.index}
              idx={item.index}
              depth={item.depth}
              active={activeIndex === item.index.index}
              canWrite={access.canWrite}
              writeReason={access.reason}
              onOpen={() => openIndex(item.index.index)}
              onSearch={() => openSearch(item.index.index)}
              onDelete={() => requestDelete(item.index.index)}
            />
          ),
        )}
        {windowed && <div style={{ height: (items.length - end) * ROW_H }} aria-hidden />}
      </div>
    </div>
  );
}

function IndexRow({
  idx,
  depth,
  active,
  canWrite,
  writeReason,
  onOpen,
  onSearch,
  onDelete,
}: {
  idx: OsIndex;
  depth: number;
  active: boolean;
  canWrite: boolean;
  writeReason: string | null;
  onOpen: () => void;
  onSearch: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={active}
      aria-label={idx.index}
      className={cn('group/idx relative items-stretch', sidebarRowClass(active))}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 cursor-default items-center gap-2 pr-2 text-left"
        style={{ paddingLeft: 8 + depth * 16 }}
        title={`${idx.index} · ${idx.health} · ${idx.status} · ${idx.docsCount.toLocaleString()} docs · ${fmtBytes(idx.storeBytes)}`}
      >
        <HealthDot health={idx.health} />
        <span className={cn('min-w-0 flex-1 truncate', idx.status === 'close' && 'opacity-60')}>
          {idx.index}
        </span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--wb-text-3)] group-focus-within/idx:invisible group-hover/idx:invisible">
          {idx.status === 'close' ? 'closed' : fmtCount(idx.docsCount)}
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
            onSearch();
          }}
        >
          <Search />
        </IconButton>
        <IconButton
          variant="plain"
          label={`Delete index ${idx.index}`}
          title={writeReason ?? 'Delete index'}
          className="h-5 w-5 hover:text-destructive"
          disabled={!canWrite}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <Trash2 />
        </IconButton>
      </div>
    </div>
  );
}
