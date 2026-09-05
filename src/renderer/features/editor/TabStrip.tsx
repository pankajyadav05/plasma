import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { kbd } from '@/lib/platform';
import { tabIsDirty, useSession } from '@/stores/session';
import type { TabKind } from '@/stores/session';
import {
  Activity,
  Boxes,
  Clock,
  FileCode,
  KeyRound,
  PanelLeft,
  PanelLeftClose,
  Plus,
  Radio,
  Search,
  SquareTerminal,
  Table2,
  Terminal,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

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

export function TabStrip() {
  const tabs = useSession((s) => s.tabs);
  const activeTabId = useSession((s) => s.activeTabId);
  const setActiveTab = useSession((s) => s.setActiveTab);
  const closeTab = useSession((s) => s.closeTab);
  const addTab = useSession((s) => s.addTab);
  const renameTab = useSession((s) => s.renameTab);
  const beginRenameTab = useSession((s) => s.beginRenameTab);
  const renamingTabId = useSession((s) => s.renamingTabId);
  const sidebarCollapsed = useSession((s) => s.settings.sidebarCollapsed);
  const toggleSidebar = useSession((s) => s.toggleSidebar);
  // The `+` button creates a fresh SQL tab; that only makes sense for
  // Postgres. For redis / opensearch the user spawns tabs from the sidebar.
  const engine = useSession((s) => s.activeConfig?.engine ?? 'postgres');
  const showAddTab = engine === 'postgres';

  return (
    <div className="flex h-10 shrink-0 items-stretch border-b border-border bg-background">
      <div className="flex shrink-0 items-center border-r border-border">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void toggleSidebar()}
          aria-label={
            sidebarCollapsed ? `Show sidebar (${kbd('B')})` : `Hide sidebar (${kbd('B')})`
          }
          title={sidebarCollapsed ? `Show sidebar (${kbd('B')})` : `Hide sidebar (${kbd('B')})`}
          className="mx-1"
        >
          {sidebarCollapsed ? <PanelLeft /> : <PanelLeftClose />}
        </Button>
      </div>
      <div
        className="scrollbar-none relative flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden [mask-image:linear-gradient(to_right,transparent,black_16px,black_calc(100%-16px),transparent)]"
        style={{ scrollbarWidth: 'none' }}
      >
        {tabs.map((t) => {
          const active = t.id === activeTabId;
          const Icon = TAB_ICON[t.kind] ?? FileCode;
          const dirty = tabIsDirty(t);
          const renaming = renamingTabId === t.id;
          return (
            <div
              key={t.id}
              className={cn(
                'group relative flex min-w-0 cursor-pointer items-center gap-2 border-r border-border px-4 transition-colors',
                active
                  ? 'bg-card text-foreground'
                  : 'text-muted-foreground hover:bg-[var(--bg-hover)] hover:text-foreground',
              )}
              onClick={() => setActiveTab(t.id)}
              onDoubleClick={(e) => {
                e.stopPropagation();
                beginRenameTab(t.id);
              }}
              role="tab"
              aria-selected={active}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !renaming) setActiveTab(t.id);
                if (e.key === 'F2') {
                  e.preventDefault();
                  beginRenameTab(t.id);
                }
              }}
              title={dirty ? `${t.title} (unsaved edits)` : t.title}
            >
              {active && <span className="absolute inset-x-0 bottom-[-1px] h-0.5 bg-primary" />}
              <Icon
                className={cn(
                  'h-3.5 w-3.5 shrink-0',
                  active ? 'text-primary' : 'text-muted-foreground',
                )}
              />
              {t.queryRunState === 'running' && (
                <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-none bg-primary" />
              )}
              {t.queryError && <span className="shrink-0 text-xs text-primary">!</span>}
              {renaming ? (
                <TabRenameInput
                  initial={t.title}
                  onCommit={(next) => renameTab(t.id, next)}
                  onCancel={() => beginRenameTab(null)}
                />
              ) : (
                <span className="flex max-w-[180px] items-center gap-1 truncate text-sm">
                  <span className="truncate">{t.title}</span>
                  {dirty && (
                    <span
                      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                      aria-label="Unsaved edits"
                    />
                  )}
                </span>
              )}
              {tabs.length > 1 && !renaming && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="h-6 w-6 shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.id);
                  }}
                  aria-label={`Close ${t.title}`}
                >
                  <X />
                </Button>
              )}
            </div>
          );
        })}
      </div>
      {showAddTab && (
        <div className="flex shrink-0 items-center border-l">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={addTab}
            aria-label="New SQL tab"
            title={`New SQL tab (${kbd('T')})`}
            className="mx-1"
          >
            <Plus />
          </Button>
        </div>
      )}
    </div>
  );
}

function TabRenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (next: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => {
        const trimmed = value.trim();
        if (!trimmed || trimmed === initial) onCancel();
        else onCommit(trimmed);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          const trimmed = value.trim();
          if (!trimmed || trimmed === initial) onCancel();
          else onCommit(trimmed);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      className="h-6 max-w-[180px] min-w-[80px] rounded-sm border border-border bg-background px-1 text-sm text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
      aria-label="Rename tab"
    />
  );
}
