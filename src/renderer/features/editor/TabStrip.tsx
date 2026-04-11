import { FileCode, Plus, Table2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { useSession } from '@/stores/session';

export function TabStrip() {
  const tabs = useSession((s) => s.tabs);
  const activeTabId = useSession((s) => s.activeTabId);
  const setActiveTab = useSession((s) => s.setActiveTab);
  const closeTab = useSession((s) => s.closeTab);
  const addTab = useSession((s) => s.addTab);

  return (
    <div className="flex h-10 shrink-0 items-stretch border-b border-border-soft bg-paper">
      <div
        className="scrollbar-none flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden"
        style={{ scrollbarWidth: 'none' }}
      >
        {tabs.map((t) => {
          const active = t.id === activeTabId;
          const Icon = t.kind === 'table' ? Table2 : FileCode;
          return (
            <div
              key={t.id}
              className={cn(
                'group relative flex min-w-0 cursor-pointer items-center gap-2 border-r border-border-soft px-4 transition-colors',
                active
                  ? 'bg-paper-canvas text-ink'
                  : 'text-ink-muted hover:bg-[var(--bg-hover)] hover:text-ink',
              )}
              onClick={() => setActiveTab(t.id)}
              role="tab"
              aria-selected={active}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setActiveTab(t.id);
              }}
            >
              {active && (
                <span className="absolute inset-x-0 bottom-[-1px] h-0.5 bg-accent" />
              )}
              <Icon className={cn('h-3.5 w-3.5 shrink-0', active ? 'text-accent' : 'text-ink-muted')} />
              {t.queryRunState === 'running' && (
                <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-none bg-accent" />
              )}
              {t.queryError && (
                <span className="shrink-0 text-xs text-accent">!</span>
              )}
              <span className="max-w-[180px] truncate font-mono text-sm">{t.title}</span>
              {tabs.length > 1 && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="h-4 w-4 shrink-0 rounded-sm opacity-0 transition-opacity group-hover:opacity-100"
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
      <div className="shrink-0 border-l border-border-soft">
        <Button
          variant="ghost"
          size="icon"
          onClick={addTab}
          aria-label="New SQL tab"
          title="New SQL tab (⌘T)"
          className="h-full w-10 rounded-none"
        >
          <Plus />
        </Button>
      </div>
    </div>
  );
}
