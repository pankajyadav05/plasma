import { Button } from '@/components/ui/button';
import { formatDuration } from '@/lib/format';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import type { HistoryEntry } from '@shared/protocol';
import { AlertCircle, Maximize2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { SidebarEmpty, SidebarSearch } from './sidebar-parts';

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

  const [search, setSearch] = useState('');
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);

  const load = useCallback(
    async (term: string) => {
      if (!connId) return;
      try {
        const next = await ipc.history.list({
          limit: LIMIT,
          connectionId: connId,
          search: term.trim() || undefined,
        });
        setEntries(next);
      } catch (err) {
        console.error('[plasma] sidebar history load failed', err);
        setEntries([]);
      }
    },
    [connId],
  );

  useEffect(() => {
    if (anyRunning) return;
    const handle = window.setTimeout(() => void load(search), search ? 200 : 0);
    return () => window.clearTimeout(handle);
  }, [search, load, anyRunning]);

  const groups = useMemo(() => groupByDay(entries ?? []), [entries]);

  const reuse = (sql: string) => {
    addTab();
    setSql(sql);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-sidebar-border px-3 py-2">
        <SidebarSearch value={search} onChange={setSearch} placeholder="Search history…" />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void load(search)}
          aria-label="Reload history"
          title="Reload"
        >
          <RefreshCw />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setCanvasMode('history')}
          aria-label="Open full history"
          title="Open full history (all connections, facets)"
        >
          <Maximize2 />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {entries === null ? (
          <SidebarEmpty title="loading…" />
        ) : entries.length === 0 ? (
          <SidebarEmpty
            title={search ? `nothing matches "${search}"` : 'No history yet'}
            hint={search ? undefined : 'Statements you run on this connection appear here.'}
          />
        ) : (
          groups.map((g) => (
            <div key={g.label} className="mb-1">
              <div className="px-4 pb-0.5 pt-2 font-display text-xs italic text-muted-foreground">
                {g.label}
              </div>
              {g.entries.map((e) => (
                <HistoryRow key={e.id} entry={e} onReuse={() => reuse(e.sql)} />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function HistoryRow({ entry, onReuse }: { entry: HistoryEntry; onReuse: () => void }) {
  const time = new Date(entry.executedAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  return (
    <button
      type="button"
      onClick={onReuse}
      title={`${entry.sql}\n\nClick to open in a new tab`}
      className="mx-2 flex w-[calc(100%-1rem)] flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent"
    >
      <span className="line-clamp-2 break-all font-mono text-[11px] leading-4 text-foreground">
        {entry.sql.replace(/\s+/g, ' ').trim()}
      </span>
      <span className="flex items-center gap-2 font-mono text-[10px] tabular-nums text-muted-foreground">
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
