import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { IconButton, MenuItem, Pill } from '@/components/ui/workbench';
import { cleanIpcError } from '@/lib/errors';
import { formatDuration } from '@/lib/format';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import type { HistoryEntry } from '@shared/protocol';
import {
  AlertCircle,
  BookmarkPlus,
  Copy,
  FilePlus2,
  Maximize2,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type ContextMenuState, SidebarContextMenu } from './SidebarContextMenu';
import { SidebarEmpty, SidebarSearch, SidebarSearchRow } from './sidebar-parts';

const LIMIT = 200;

/**
 * Sidebar "History" mode — the active connection's recent statements,
 * grouped by day. Click opens the SQL in a new tab (never overwrites
 * the current buffer). Keeps its own list rather than the shared
 * `session.history` so the full-window History canvas's facets are not
 * clobbered by this compact view.
 */
export function HistoryList() {
  const connId = useSession((s) => s.activeConfig?.id);
  const addTab = useSession((s) => s.addTab);
  const setSql = useSession((s) => s.setSql);
  const setCanvasMode = useSession((s) => s.setCanvasMode);
  // Flips false when the last running tab finishes — reload then so the
  // statement that just ran shows up without a manual refresh.
  const anyRunning = useSession((s) => s.tabs.some((t) => t.queryRunState === 'running'));
  const saveSqlAsQuery = useSession((s) => s.saveSqlAsQuery);
  const deleteHistoryEntry = useSession((s) => s.deleteHistoryEntry);

  const [search, setSearch] = useState('');
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [saving, setSaving] = useState<{ sql: string; name: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const load = useCallback(
    async (term: string) => {
      if (!connId) return;
      const seq = ++requestSeq.current;
      try {
        const next = await ipc.history.list({
          limit: LIMIT,
          connectionId: connId,
          search: term.trim() || undefined,
        });
        if (seq !== requestSeq.current) return;
        setEntries(next);
        setLoadError(null);
      } catch (err) {
        if (seq !== requestSeq.current) return;
        console.error('[plasma] sidebar history load failed', err);
        // PC8: a failure is an error, not an empty history.
        setLoadError(cleanIpcError(err instanceof Error ? err.message : String(err)));
      }
    },
    [connId],
  );

  // Search is never suspended while a query runs (PC8); a run finishing
  // (anyRunning → false) reloads so the new statement shows up.
  useEffect(() => {
    const handle = window.setTimeout(() => void load(search), search ? 200 : 0);
    return () => window.clearTimeout(handle);
  }, [search, load]);

  const wasRunning = useRef(anyRunning);
  useEffect(() => {
    if (wasRunning.current && !anyRunning) void load(search);
    wasRunning.current = anyRunning;
  }, [anyRunning, load, search]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 2500);
    return () => window.clearTimeout(t);
  }, [notice]);

  const copySql = async (sql: string) => {
    try {
      await navigator.clipboard.writeText(sql);
      setNotice('Copied SQL');
    } catch (err) {
      setNotice(cleanIpcError(err instanceof Error ? err.message : String(err)));
    }
  };

  const confirmSave = async () => {
    if (!saving || !saving.name.trim()) return;
    await saveSqlAsQuery(saving.name, saving.sql);
    setSaving(null);
    setNotice('Saved to Queries');
  };

  const groups = useMemo(() => groupByDay(entries ?? []), [entries]);

  const reuse = (sql: string) => {
    addTab();
    setSql(sql);
  };

  return (
    <div className="flex h-full flex-col">
      <SidebarSearchRow>
        <SidebarSearch
          value={search}
          onChange={setSearch}
          placeholder="Search for history…"
          ariaLabel="Search history"
        />
        <HistoryActionsMenu
          onReload={() => void load(search)}
          onOpenFull={() => setCanvasMode('history')}
        />
      </SidebarSearchRow>

      {saving && (
        <div className="flex shrink-0 items-center gap-1.5 px-2.5 pb-2">
          <input
            // biome-ignore lint/a11y/noAutofocus: naming field appears on explicit user action
            autoFocus
            type="text"
            value={saving.name}
            onChange={(e) => setSaving({ ...saving, name: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void confirmSave();
              else if (e.key === 'Escape') setSaving(null);
            }}
            placeholder="Name this query…"
            aria-label="Saved query name"
            className="h-[26px] min-w-0 flex-1 rounded-[7px] border-0 bg-[var(--wb-field)] px-2.5 text-[13px] text-[var(--wb-text)] outline-none shadow-[0_0_0_2px_color-mix(in_srgb,var(--wb-accent)_55%,transparent)] placeholder:text-[var(--wb-text-3)]"
          />
          <Pill onClick={() => void confirmSave()} disabled={!saving.name.trim()}>
            Save
          </Pill>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {loadError ? (
          <div className="px-4 py-3">
            <div className="text-[13px] text-destructive">Could not load history</div>
            <div className="mt-1 break-words text-[11px] text-[var(--wb-text-2)]">{loadError}</div>
            <Pill className="mt-2" onClick={() => void load(search)}>
              <RefreshCw />
              Retry
            </Pill>
          </div>
        ) : entries === null ? (
          <SidebarEmpty title="loading…" />
        ) : entries.length === 0 ? (
          <SidebarEmpty
            title={search ? `nothing matches "${search}"` : 'No history yet'}
            hint={search ? undefined : 'Statements you run on this connection appear here.'}
          />
        ) : (
          groups.map((g) => (
            <div key={g.label} className="mb-1">
              <div className="px-4 pb-1 pt-2 text-[11px] font-semibold text-[var(--wb-text-2)]">
                {g.label}
              </div>
              {g.entries.map((e) => (
                <HistoryRow
                  key={e.id}
                  entry={e}
                  onReuse={() => reuse(e.sql)}
                  onContextMenu={(ev) => {
                    ev.preventDefault();
                    setMenu({
                      x: ev.clientX,
                      y: ev.clientY,
                      entries: [
                        {
                          type: 'item',
                          label: 'Open in new tab',
                          icon: <FilePlus2 />,
                          onSelect: () => reuse(e.sql),
                        },
                        {
                          type: 'item',
                          label: 'Copy SQL',
                          icon: <Copy />,
                          onSelect: () => void copySql(e.sql),
                        },
                        {
                          type: 'item',
                          label: 'Save as query…',
                          icon: <BookmarkPlus />,
                          onSelect: () =>
                            setSaving({
                              sql: e.sql,
                              name: e.sql.replace(/\s+/g, ' ').trim().slice(0, 40),
                            }),
                        },
                        { type: 'separator' },
                        {
                          type: 'item',
                          label: 'Delete from history',
                          icon: <Trash2 />,
                          destructive: true,
                          onSelect: () => {
                            setEntries((cur) => cur?.filter((x) => x.id !== e.id) ?? cur);
                            void deleteHistoryEntry(e.id).catch((err) =>
                              setNotice(
                                cleanIpcError(err instanceof Error ? err.message : String(err)),
                              ),
                            );
                          },
                        },
                      ],
                    });
                  }}
                />
              ))}
            </div>
          ))
        )}
      </div>

      {notice && (
        <output className="block shrink-0 truncate border-t border-[var(--wb-separator)] px-3 py-1 text-[11px] text-[var(--wb-text-2)]">
          {notice}
        </output>
      )}
      <SidebarContextMenu state={menu} onClose={() => setMenu(null)} />
    </div>
  );
}

/** Reload / open-full-history actions behind the sliders button. */
function HistoryActionsMenu({
  onReload,
  onOpenFull,
}: {
  onReload: () => void;
  onOpenFull: () => void;
}) {
  const [open, setOpen] = useState(false);
  const run = (fn: () => void) => {
    setOpen(false);
    fn();
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton variant="plain" label="History options" className="[&_svg]:h-4 [&_svg]:w-4">
          <SlidersHorizontal />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={4} className="w-[260px] p-1" role="menu">
        <MenuItem icon={<RefreshCw />} label="Reload history" onClick={() => run(onReload)} />
        <MenuItem
          icon={<Maximize2 />}
          label="Open full history"
          hint="all connections"
          onClick={() => run(onOpenFull)}
        />
      </PopoverContent>
    </Popover>
  );
}

function HistoryRow({
  entry,
  onReuse,
  onContextMenu,
}: {
  entry: HistoryEntry;
  onReuse: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const time = new Date(entry.executedAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  return (
    <button
      type="button"
      onClick={onReuse}
      onContextMenu={onContextMenu}
      title={`${entry.sql}\n\nClick to open in a new tab · right-click for more`}
      className="mx-2 flex w-[calc(100%-1rem)] flex-col justify-center gap-px rounded-[5px] px-2 py-1 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--wb-text)_6%,transparent)]"
    >
      <span className="block w-full truncate font-mono text-[12px] leading-[18px] text-[var(--wb-text)]">
        {entry.sql.replace(/\s+/g, ' ').trim()}
      </span>
      <span className="flex items-center gap-2 text-[11px] tabular-nums text-[var(--wb-text-3)]">
        <span>{time}</span>
        {entry.error ? (
          <span className="flex items-center gap-1 text-destructive">
            <AlertCircle className="h-2.5 w-2.5" />
            error
          </span>
        ) : (
          <>
            {entry.rowCount !== null && <span>{entry.rowCount.toLocaleString()} rows</span>}
            {entry.durationMs !== null && <span>{formatDuration(entry.durationMs)}</span>}
          </>
        )}
      </span>
    </button>
  );
}

/** Bucket entries (already newest-first) under Today / Yesterday / date labels. */
export function groupByDay(
  entries: HistoryEntry[],
  now: Date = new Date(),
): Array<{ label: string; entries: HistoryEntry[] }> {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = startOfDay(now);
  const yesterday = today - 86_400_000;
  const out: Array<{ label: string; entries: HistoryEntry[] }> = [];
  for (const e of entries) {
    const day = startOfDay(new Date(e.executedAt));
    const label =
      day === today
        ? 'Today'
        : day === yesterday
          ? 'Yesterday'
          : new Date(day).toLocaleDateString([], {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
            });
    const last = out[out.length - 1];
    if (last && last.label === label) last.entries.push(e);
    else out.push({ label, entries: [e] });
  }
  return out;
}
