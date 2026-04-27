import { useEffect, useMemo } from 'react';
import { Clock, Flame, Play } from 'lucide-react';
import type { HistoryEntry } from '@shared/protocol';
import { BrandMark } from '@/features/app-shell/BrandMark';
import { formatDuration } from '@/lib/format';
import { useSession } from '@/stores/session';

/**
 * Home panel for empty SQL tabs. Instead of a blank editor, we show the
 * user their most recent + most frequently-run queries so they can
 * relaunch something they already wrote. Selecting an entry paves the
 * SQL into the current tab and expands the editor.
 *
 * Displayed only when: kind === 'sql', sql is empty, no queryResult,
 * not running, no error. Falls back to a "write something" blurb when
 * history is empty.
 */
export function SqlHomePanel() {
  const history = useSession((s) => s.history);
  const loadHistory = useSession((s) => s.loadHistory);
  const activeConfigId = useSession((s) => s.activeConfig?.id);
  const setSql = useSession((s) => s.setSql);
  const setEditorExpanded = useSession((s) => s.setEditorExpanded);

  useEffect(() => {
    if (history.length === 0) void loadHistory();
  }, [history.length, loadHistory]);

  // Only entries for the currently connected DB — running someone
  // else's past query against a different schema is a footgun.
  const scoped = useMemo(
    () =>
      activeConfigId
        ? history.filter((h) => h.connectionId === activeConfigId && !h.error)
        : history.filter((h) => !h.error),
    [history, activeConfigId],
  );

  const recent = scoped.slice(0, 6);
  const frequent = useMemo(() => topFrequent(scoped, 6), [scoped]);

  const use = (sql: string) => {
    setSql(sql);
    setEditorExpanded(true);
  };

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-card">
      <div className="flex max-w-2xl flex-col items-center gap-6 text-center">
        <BrandMark className="h-16 w-16 text-foreground/70" />
        <div className="font-display text-2xl italic text-muted-foreground">
          start where you left off
        </div>

        {scoped.length === 0 ? (
          <div className="px-8 font-display text-sm italic text-muted-foreground">
            no history yet — write a query in the editor on the right
          </div>
        ) : (
          <div className="grid w-full grid-cols-1 gap-6 px-4 text-left md:grid-cols-2">
            {recent.length > 0 && (
              <Column heading="Recent" icon={<Clock className="h-3.5 w-3.5" />}>
                {recent.map((entry) => (
                  <HistoryItem key={entry.id} entry={entry} onClick={() => use(entry.sql)} />
                ))}
              </Column>
            )}
            {frequent.length > 0 && (
              <Column heading="Frequent" icon={<Flame className="h-3.5 w-3.5" />}>
                {frequent.map(({ entry, count }) => (
                  <HistoryItem
                    key={entry.id}
                    entry={entry}
                    trailing={<span className="text-xs text-muted-foreground">×{count}</span>}
                    onClick={() => use(entry.sql)}
                  />
                ))}
              </Column>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Column({
  heading,
  icon,
  children,
}: {
  heading: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5 px-2 pb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {icon}
        {heading}
      </div>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}

function HistoryItem({
  entry,
  trailing,
  onClick,
}: {
  entry: HistoryEntry;
  trailing?: React.ReactNode;
  onClick: () => void;
}) {
  const snippet = singleLine(entry.sql).slice(0, 80);
  return (
    <button
      type="button"
      onClick={onClick}
      className="group/home flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left transition-colors hover:border-primary hover:bg-accent/50"
      title={entry.sql}
    >
      <Play className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground group-hover/home:text-primary" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-xs text-foreground">
          {snippet}
          {entry.sql.length > 80 ? '…' : ''}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>{relativeTime(entry.executedAt)}</span>
          {entry.rowCount !== null && <span>· {entry.rowCount.toLocaleString()} rows</span>}
          {entry.durationMs !== null && <span>· {formatDuration(entry.durationMs)}</span>}
        </div>
      </div>
      {trailing}
    </button>
  );
}

function singleLine(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/**
 * Group history entries by their normalized SQL text, then pick the top
 * `n` by occurrence count. The most-recent instance of each query is
 * kept so the displayed row stays meaningful (timestamps, row count).
 */
function topFrequent(
  entries: HistoryEntry[],
  n: number,
): Array<{ entry: HistoryEntry; count: number }> {
  const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim().toLowerCase();
  const groups = new Map<string, { entry: HistoryEntry; count: number }>();
  for (const entry of entries) {
    const key = norm(entry.sql);
    if (!key) continue;
    const existing = groups.get(key);
    if (existing) {
      existing.count++;
      // Keep the most recent instance as the representative row
      if (entry.executedAt > existing.entry.executedAt) existing.entry = entry;
    } else {
      groups.set(key, { entry, count: 1 });
    }
  }
  return [...groups.values()]
    .filter((g) => g.count > 1)
    .sort((a, b) => b.count - a.count || b.entry.executedAt - a.entry.executedAt)
    .slice(0, n);
}
