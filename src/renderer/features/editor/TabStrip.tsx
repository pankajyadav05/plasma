import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { MenuItem } from '@/components/ui/workbench';
import { cn } from '@/lib/cn';
import { shortcut } from '@/lib/platform';
import { useSession } from '@/stores/session';
import type { TabKind } from '@/stores/session';
import { isPreviewTab, isTabDirty } from '@/stores/session-tabs';
import {
  Activity,
  Boxes,
  ChevronDown,
  Clock,
  Copy,
  FileCode,
  KeyRound,
  LayoutDashboard,
  Pencil,
  Pin,
  Plus,
  Radio,
  Search,
  Server,
  SquareTerminal,
  Table2,
  Terminal,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

const TAB_ICON: Record<TabKind, LucideIcon> = {
  sql: FileCode,
  table: Table2,
  'redis-key': KeyRound,
  'redis-cli': Terminal,
  'redis-pubsub': Radio,
  'redis-analyze': Activity,
  'redis-slowlog': Clock,
  'redis-server': Server,
  'os-search': Search,
  'os-index': Boxes,
  'os-sql': SquareTerminal,
  'os-console': Terminal,
};

/** What the strip renders per tab — primitives only, so typing SQL doesn't re-render it (F13). */
interface TabView {
  id: string;
  title: string;
  kind: TabKind;
  running: boolean;
  failed: boolean;
  preview: boolean;
  dirty: boolean;
}

const SEP = '\u0001';

function useTabViews(): TabView[] {
  const keys = useSession(
    useShallow((s) => {
      const edited = new Set(s.pendingEdits.map((e) => e.tabId));
      return s.tabs.map((t) =>
        [
          t.id,
          t.kind,
          t.queryRunState === 'running' ? 1 : 0,
          t.queryError ? 1 : 0,
          isPreviewTab(t, edited) ? 1 : 0,
          isTabDirty(t) ? 1 : 0,
          t.title,
        ].join(SEP),
      );
    }),
  );
  return useMemo(
    () =>
      keys.map((k) => {
        const [id, kind, running, failed, preview, dirty, ...title] = k.split(SEP);
        return {
          id: id!,
          kind: kind as TabKind,
          running: running === '1',
          failed: failed === '1',
          preview: preview === '1',
          dirty: dirty === '1',
          title: title.join(SEP),
        };
      }),
    [keys],
  );
}

/**
 * Object tabs, TablePlus-style: tabs share the strip's width with a
 * minimum width; past that the strip scrolls horizontally, the active tab
 * is always scrolled into view, and a ⌄ menu lists every tab (VF17).
 * Single-click table opens are *preview* tabs (italic) that the next
 * single click replaces; double-click pins. Right-click for Close /
 * Close Others / Close to the Right / Close All / Duplicate / Rename;
 * middle-click closes. Tabs with unsaved SQL show a dot.
 */
export function TabStrip() {
  const tabs = useTabViews();
  const activeTabId = useSession((s) => s.activeTabId);
  const setActiveTab = useSession((s) => s.setActiveTab);
  const requestCloseTabs = useSession((s) => s.requestCloseTabs);
  const closeOtherTabs = useSession((s) => s.closeOtherTabs);
  const closeTabsToRight = useSession((s) => s.closeTabsToRight);
  const closeAllTabs = useSession((s) => s.closeAllTabs);
  const duplicateTab = useSession((s) => s.duplicateTab);
  const renameTab = useSession((s) => s.renameTab);
  const pinTab = useSession((s) => s.pinTab);
  const moveTab = useSession((s) => s.moveTab);
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

  const listRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [overflowMenu, setOverflowMenu] = useState(false);
  const dragId = useRef<string | null>(null);

  // Show the ⌄ menu only when the tabs don't fit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when tabs are added / removed
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const check = () => setOverflowing(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [visible.length]);

  // The active tab is always scrolled into view (never hidden behind "+").
  // biome-ignore lint/correctness/useExhaustiveDependencies: also re-run when a tab opens or closes
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-tab-id="${CSS.escape(activeTabId)}"]`,
    );
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId, visible.length]);

  const titleOf = (t: TabView) => (t.id === overviewId ? 'Overview' : t.title);
  const closableIds = visible.filter((t) => t.id !== overviewId).map((t) => t.id);
  const canClose = (t: TabView) => visible.length > 1 && t.id !== overviewId;
  const menuTab = menu ? visible.find((t) => t.id === menu.id) : undefined;
  const menuIdx = menuTab ? visible.indexOf(menuTab) : -1;

  const focusTab = (idx: number) => {
    const t = visible[(idx + visible.length) % visible.length];
    if (!t) return;
    setActiveTab(t.id);
    listRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(t.id)}"]`)?.focus();
  };

  return (
    <div className="flex h-[34px] shrink-0 items-stretch border-b border-[var(--wb-separator)] bg-[var(--wb-tabbar)]">
      <div
        ref={listRef}
        className="scrollbar-none flex min-w-0 flex-1 items-stretch gap-1 overflow-x-auto p-1"
        role="tablist"
        aria-label="Open tabs"
      >
        {visible.map((t, idx) => {
          const active = t.id === activeTabId;
          const isOverview = t.id === overviewId;
          const Icon = isOverview ? LayoutDashboard : (TAB_ICON[t.kind] ?? FileCode);
          const title = titleOf(t);
          const closable = canClose(t);
          return (
            <div
              key={t.id}
              data-tab-id={t.id}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              draggable={!isOverview && renaming !== t.id}
              onDragStart={(e) => {
                dragId.current = t.id;
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                if (dragId.current && dragId.current !== t.id) e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                const from = dragId.current;
                dragId.current = null;
                if (from && from !== t.id) {
                  moveTab(
                    from,
                    tabs.findIndex((x) => x.id === t.id),
                  );
                }
              }}
              onClick={() => setActiveTab(t.id)}
              onDoubleClick={() => {
                if (t.preview) pinTab(t.id);
                else if (!isOverview) setRenaming(t.id);
              }}
              onAuxClick={(e) => {
                if (e.button === 1 && closable) requestCloseTabs([t.id]);
              }}
              onMouseDown={(e) => {
                // Stop the middle-button autoscroll cursor.
                if (e.button === 1) e.preventDefault();
              }}
              onContextMenu={(e) => {
                if (isOverview) return;
                e.preventDefault();
                setMenu({ id: t.id, x: e.clientX, y: e.clientY });
              }}
              onKeyDown={(e) => {
                if (renaming === t.id) return;
                if (e.key === 'Enter') setActiveTab(t.id);
                else if (e.key === 'ArrowRight') focusTab(idx + 1);
                else if (e.key === 'ArrowLeft') focusTab(idx - 1);
                else if (e.key === 'Home') focusTab(0);
                else if (e.key === 'End') focusTab(visible.length - 1);
                else if ((e.key === 'Delete' || e.key === 'Backspace') && closable)
                  requestCloseTabs([t.id]);
                else if (e.key === 'F2' && !isOverview) setRenaming(t.id);
                else return;
                e.preventDefault();
              }}
              title={t.preview ? `${title} — preview (double-click to keep open)` : title}
              className={cn(
                'group relative flex min-w-[132px] max-w-[260px] flex-1 basis-0 cursor-default items-center justify-center gap-1.5 rounded-[7px] px-7 text-[13px] leading-5 transition-colors',
                active
                  ? 'bg-[var(--wb-control-active)] text-[var(--wb-text)] shadow-[0_0.5px_1px_rgb(0_0_0/0.2)]'
                  : 'text-[var(--wb-text-2)] hover:bg-[var(--wb-control-hover)] hover:text-[var(--wb-text)]',
              )}
            >
              {closable && (
                <button
                  type="button"
                  tabIndex={-1}
                  className={cn(
                    'absolute left-1 top-1/2 grid h-[18px] w-[18px] -translate-y-1/2 place-items-center rounded-[4px] text-[var(--wb-text-2)] transition-opacity hover:bg-[var(--wb-control-hover)] hover:text-[var(--wb-text)] focus-visible:opacity-100 group-hover:opacity-100',
                    t.dirty ? 'opacity-100' : 'opacity-0',
                  )}
                  onClick={(e) => {
                    e.stopPropagation();
                    requestCloseTabs([t.id]);
                  }}
                  aria-label={`Close ${title}`}
                  title={`Close (${shortcut('closeTab')})`}
                >
                  {t.dirty ? (
                    <>
                      <span
                        className="h-2 w-2 rounded-full bg-[var(--wb-text-2)] group-hover:hidden"
                        aria-hidden
                      />
                      <X className="hidden h-3 w-3 group-hover:block" />
                    </>
                  ) : (
                    <X className="h-3 w-3" />
                  )}
                </button>
              )}
              <Icon className="h-3.5 w-3.5 shrink-0 opacity-60" />
              {renaming === t.id ? (
                <RenameInput
                  initial={t.title}
                  onDone={(value) => {
                    setRenaming(null);
                    if (value !== null) renameTab(t.id, value);
                  }}
                />
              ) : (
                <span className={cn('truncate', t.preview && 'italic')}>{title}</span>
              )}
              {t.dirty && <span className="sr-only">(unsaved)</span>}
              {t.running && (
                <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--wb-accent)]" />
              )}
              {t.failed && (
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-destructive"
                  title="Last run failed"
                />
              )}
            </div>
          );
        })}
      </div>

      {overflowing && (
        <Popover open={overflowMenu} onOpenChange={setOverflowMenu}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="All tabs"
              title="All tabs"
              className="my-1 grid w-[26px] shrink-0 place-items-center rounded-[7px] text-[var(--wb-text-2)] transition-colors hover:bg-[var(--wb-control-hover)] hover:text-[var(--wb-text)]"
            >
              <ChevronDown className="h-4 w-4" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            sideOffset={4}
            className="max-h-[60vh] w-[260px] overflow-y-auto p-1"
            role="menu"
          >
            {visible.map((t) => {
              const Icon = t.id === overviewId ? LayoutDashboard : (TAB_ICON[t.kind] ?? FileCode);
              return (
                <MenuItem
                  key={t.id}
                  icon={<Icon />}
                  label={<span className={cn(t.preview && 'italic')}>{titleOf(t)}</span>}
                  hint={t.dirty ? 'unsaved' : undefined}
                  checked={t.id === activeTabId ? true : undefined}
                  onClick={() => {
                    setOverflowMenu(false);
                    setActiveTab(t.id);
                  }}
                />
              );
            })}
          </PopoverContent>
        </Popover>
      )}

      {engine === 'postgres' && (
        <button
          type="button"
          aria-label={`New SQL tab (${shortcut('newTab')})`}
          title={`New SQL tab (${shortcut('newTab')})`}
          onClick={addTab}
          className="my-1 mr-1 grid w-[30px] shrink-0 place-items-center rounded-[7px] text-[var(--wb-text-2)] transition-colors hover:bg-[var(--wb-control-hover)] hover:text-[var(--wb-text)]"
        >
          <Plus className="h-4 w-4" />
        </button>
      )}

      <Popover open={menu !== null} onOpenChange={(open) => !open && setMenu(null)}>
        <PopoverAnchor asChild>
          <span
            aria-hidden
            className="pointer-events-none fixed h-0 w-0"
            style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }}
          />
        </PopoverAnchor>
        <PopoverContent align="start" sideOffset={2} className="w-[220px] p-1" role="menu">
          {menuTab && (
            <>
              {menuTab.preview && (
                <MenuItem
                  icon={<Pin />}
                  label="Keep open"
                  onClick={() => {
                    setMenu(null);
                    pinTab(menuTab.id);
                  }}
                />
              )}
              <MenuItem
                icon={<X />}
                label="Close"
                hint={shortcut('closeTab')}
                disabled={!canClose(menuTab)}
                onClick={() => {
                  setMenu(null);
                  requestCloseTabs([menuTab.id]);
                }}
              />
              <MenuItem
                label="Close Others"
                disabled={closableIds.length < 2}
                onClick={() => {
                  setMenu(null);
                  closeOtherTabs(menuTab.id);
                }}
              />
              <MenuItem
                label="Close to the Right"
                disabled={menuIdx === -1 || menuIdx >= visible.length - 1}
                onClick={() => {
                  setMenu(null);
                  closeTabsToRight(menuTab.id);
                }}
              />
              <MenuItem
                label="Close All"
                onClick={() => {
                  setMenu(null);
                  closeAllTabs();
                }}
              />
              <div className="my-1 h-px bg-[var(--wb-separator)]" />
              <MenuItem
                icon={<Copy />}
                label="Duplicate"
                disabled={menuTab.kind !== 'sql' && menuTab.kind !== 'table'}
                onClick={() => {
                  setMenu(null);
                  duplicateTab(menuTab.id);
                }}
              />
              <MenuItem
                icon={<Pencil />}
                label="Rename…"
                hint="F2"
                onClick={() => {
                  setMenu(null);
                  setRenaming(menuTab.id);
                }}
              />
            </>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

function RenameInput({
  initial,
  onDone,
}: { initial: string; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: inline rename starts typing immediately
      autoFocus
      aria-label="Tab name"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(value.trim() || null);
        else if (e.key === 'Escape') finish(null);
      }}
      onBlur={() => finish(value.trim() || null)}
      className="h-5 min-w-0 flex-1 rounded-[4px] border border-[var(--wb-separator)] bg-[var(--wb-content)] px-1 text-[13px] text-[var(--wb-text)] outline-none"
    />
  );
}
