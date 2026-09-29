import { cn } from '@/lib/cn';
import { kbd } from '@/lib/platform';
import { useSession } from '@/stores/session';
import type { TabKind } from '@/stores/session';
import {
  Activity,
  Boxes,
  Clock,
  FileCode,
  KeyRound,
  LayoutDashboard,
  Plus,
  Radio,
  Search,
  SquareTerminal,
  Table2,
  Terminal,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

const TAB_ICON: Record<TabKind, LucideIcon> = {
  sql: FileCode,
  table: Table2,
  'redis-key': KeyRound,
  'redis-cli': Terminal,
  'redis-pubsub': Radio,
  'redis-analyze': Activity,
  'redis-slowlog': Clock,
  'os-search': Search,
  'os-index': Boxes,
  'os-sql': SquareTerminal,
};

/**
 * Object tabs, TablePlus-style: tabs share the strip's width equally
 * with centred titles; the active tab is an inset rounded pill on the
 * flat tab bar (no track, no dividers).
 * Close sits on the leading edge and appears on hover (macOS tab
 * convention). Middle-click closes too.
 */
export function TabStrip() {
  const tabs = useSession((s) => s.tabs);
  const activeTabId = useSession((s) => s.activeTabId);
  const setActiveTab = useSession((s) => s.setActiveTab);
  const closeTab = useSession((s) => s.closeTab);
  const addTab = useSession((s) => s.addTab);
  // New SQL tabs only make sense for Postgres; redis / opensearch tabs
  // spawn from the sidebar.
  const engine = useSession((s) => s.activeConfig?.engine ?? 'postgres');
  // Redis / OpenSearch have no SQL editor: the session's placeholder SQL
  // tab renders the engine overview, so show it as a fixed "Overview" tab
  // (never "query-1.sql", never closable) and hide any extra SQL tabs.
  const keyValueEngine = engine !== 'postgres';
  const overviewId = keyValueEngine ? tabs.find((t) => t.kind === 'sql')?.id : undefined;
  const visible = keyValueEngine
    ? tabs.filter((t) => t.kind !== 'sql' || t.id === overviewId)
    : tabs;

  return (
    <div className="flex h-[34px] shrink-0 items-stretch border-b border-[var(--wb-separator)] bg-[var(--wb-tabbar)]">
      <div
        className="scrollbar-none flex min-w-0 flex-1 items-stretch gap-1 overflow-x-auto p-1"
        role="tablist"
        aria-label="Open tabs"
      >
        {visible.map((t) => {
          const active = t.id === activeTabId;
          const isOverview = t.id === overviewId;
          const Icon = isOverview ? LayoutDashboard : (TAB_ICON[t.kind] ?? FileCode);
          const title = isOverview ? 'Overview' : t.title;
          const closable = visible.length > 1 && !isOverview;
          return (
            <div
              key={t.id}
              role="tab"
              aria-selected={active}
              tabIndex={0}
              onClick={() => setActiveTab(t.id)}
              onAuxClick={(e) => {
                if (e.button === 1 && closable) closeTab(t.id);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setActiveTab(t.id);
              }}
              title={title}
              className={cn(
                'group relative flex min-w-[120px] flex-1 basis-0 cursor-default items-center justify-center gap-1.5 rounded-[7px] px-7 text-[13px] leading-5 transition-colors',
                active
                  ? 'bg-[var(--wb-control-active)] text-[var(--wb-text)] shadow-[0_0.5px_1px_rgb(0_0_0/0.2)]'
                  : 'text-[var(--wb-text-2)] hover:bg-[var(--wb-control-hover)] hover:text-[var(--wb-text)]',
              )}
            >
              {closable && (
                <button
                  type="button"
                  className="absolute left-1 top-1/2 grid h-[18px] w-[18px] -translate-y-1/2 place-items-center rounded-[4px] text-[var(--wb-text-2)] opacity-0 transition-opacity hover:bg-[var(--wb-control-hover)] hover:text-[var(--wb-text)] focus-visible:opacity-100 group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.id);
                  }}
                  aria-label={`Close ${title}`}
                  title={`Close (${kbd('W')})`}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
              <Icon className="h-3.5 w-3.5 shrink-0 opacity-60" />
              <span className="truncate">{title}</span>
              {t.queryRunState === 'running' && (
                <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--wb-accent)]" />
              )}
              {t.queryError && (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" title="Last run failed" />
              )}
            </div>
          );
        })}
      </div>
      {engine === 'postgres' && (
        <button
          type="button"
          aria-label={`New SQL tab (${kbd('T')})`}
          title={`New SQL tab (${kbd('T')})`}
          onClick={addTab}
          className="my-1 mr-1 grid w-[30px] shrink-0 place-items-center rounded-[7px] text-[var(--wb-text-2)] transition-colors hover:bg-[var(--wb-control-hover)] hover:text-[var(--wb-text)]"
        >
          <Plus className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
