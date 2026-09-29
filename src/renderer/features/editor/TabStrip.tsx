import { ToolbarButton } from '@/components/ui/workbench';
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
 * with centred titles; the active tab is a raised pill on a glass track.
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

  return (
    <div className="chrome flex h-[38px] shrink-0 items-center gap-1.5 border-b hairline px-2">
      <div
        className="glass scrollbar-none flex h-[28px] min-w-0 flex-1 items-stretch gap-[2px] overflow-x-auto rounded-[8px] p-[2px]"
        role="tablist"
        aria-label="Open tabs"
      >
        {tabs.map((t) => {
          const active = t.id === activeTabId;
          const Icon = TAB_ICON[t.kind] ?? FileCode;
          return (
            <div
              key={t.id}
              role="tab"
              aria-selected={active}
              tabIndex={0}
              onClick={() => setActiveTab(t.id)}
              onAuxClick={(e) => {
                if (e.button === 1 && tabs.length > 1) closeTab(t.id);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setActiveTab(t.id);
              }}
              title={t.title}
              className={cn(
                'group relative flex min-w-[120px] max-w-[320px] flex-1 cursor-default items-center justify-center gap-1.5 rounded-[6px] px-6 text-xs transition-colors',
                active
                  ? 'raised font-medium text-foreground'
                  : 'text-foreground/60 hover:bg-[var(--glass-fill-hover)] hover:text-foreground',
              )}
            >
              {tabs.length > 1 && (
                <button
                  type="button"
                  className="absolute left-1 top-1/2 grid h-[18px] w-[18px] -translate-y-1/2 place-items-center rounded-[4px] text-muted-foreground opacity-0 transition-opacity hover:bg-[var(--glass-fill-press)] hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.id);
                  }}
                  aria-label={`Close ${t.title}`}
                  title={`Close (${kbd('W')})`}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
              <Icon
                className={cn('h-3.5 w-3.5 shrink-0', active ? 'text-primary' : 'opacity-70')}
              />
              <span className="truncate">{t.title}</span>
              {t.queryRunState === 'running' && (
                <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
              )}
              {t.queryError && (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" title="Last run failed" />
              )}
            </div>
          );
        })}
      </div>
      {engine === 'postgres' && (
        <ToolbarButton
          label={`New SQL tab (${kbd('T')})`}
          onClick={addTab}
          className="h-7 w-7 rounded-[7px]"
        >
          <Plus />
        </ToolbarButton>
      )}
    </div>
  );
}
