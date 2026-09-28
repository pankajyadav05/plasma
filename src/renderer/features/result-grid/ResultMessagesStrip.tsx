import { cn } from '@/lib/cn';
import { formatDuration } from '@/lib/format';
import { useActiveTab, useSession } from '@/stores/session';
import type { PgNotice, QueryResult } from '@shared/protocol';
import { MessageSquareWarning } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

/**
 * U26 — result tabs + messages below the result toolbar.
 *
 * Multi-statement runs get one tab per statement (command + row count);
 * click or ⌥←/→ focuses that statement's grid. The Messages toggle
 * expands the per-statement summary with NOTICE/WARNING lines. A single
 * result only shows the strip when it produced notices; otherwise the
 * strip stays hidden.
 */
export function ResultMessagesStrip() {
  const tab = useActiveTab();
  const setActiveResultIndex = useSession((s) => s.setActiveResultIndex);
  const cycleActiveResult = useSession((s) => s.cycleActiveResult);

  const results: QueryResult[] = tab?.queryResults ?? [];
  const active = tab?.activeResultIndex ?? 0;
  const streamingNotices: Array<{ statementIndex: number; notice: PgNotice }> = tab?.queryNotices ?? [];
  const isSql = tab?.kind === 'sql';

  // ⌥← / ⌥→ cycle statements while focus is outside Monaco (Monaco owns
  // those chords inside the editor). Ignore when a modifier combo would
  // collide with browser history (⌘⌥←) — we only want Alt alone.
  useEffect(() => {
    if (!isSql || results.length <= 1) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) {
        return;
      }
      // Skip when Monaco has focus (textarea.inputarea).
      if ((e.target as HTMLElement | null)?.classList?.contains('inputarea')) return;
      e.preventDefault();
      cycleActiveResult(e.key === 'ArrowLeft' ? -1 : 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isSql, results.length, cycleActiveResult]);

  const rows = useMemo(() => {
    return results.map((r, i) => {
      const streamed = streamingNotices
        .filter((n) => n.statementIndex === i)
        .map((n) => n.notice);
      const notices = mergeNoticeLists(r.notices, streamed);
      return { index: i, result: r, notices };
    });
  }, [results, streamingNotices]);

  const noticeCount = rows.reduce((n, r) => n + r.notices.length, 0);
  const [messagesOpen, setMessagesOpen] = useState(false);

  if (!tab || !isSql) return null;
  // Hide entirely for a lone result with no notices.
  if (rows.length === 0) return null;
  if (rows.length === 1 && (rows[0]?.notices.length ?? 0) === 0) return null;

  // A single result only gets here when it has notices — show the list.
  const showList = rows.length === 1 || messagesOpen;

  return (
    <div className="flex shrink-0 flex-col border-b bg-muted/30">
      <div className="flex h-8 items-stretch">
        {rows.length > 1 ? (
          <div
            className="scrollbar-none flex min-w-0 flex-1 items-stretch overflow-x-auto"
            role="tablist"
            aria-label="Statement results · ⌥←/→ to switch"
          >
            {rows.map(({ index, result, notices }) => {
              const isActive = index === active;
              return (
                <button
                  key={index}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setActiveResultIndex(index)}
                  title={`${summarizeResult(result)} — ⌥←/→ to switch`}
                  className={cn(
                    'relative flex shrink-0 items-center gap-1.5 border-r border-border/60 px-3 font-mono text-[11px] transition-colors',
                    isActive
                      ? 'bg-background text-foreground'
                      : 'text-muted-foreground hover:bg-muted/80 hover:text-foreground',
                  )}
                >
                  <span className="font-semibold">#{index + 1}</span>
                  <span className="uppercase tracking-wide">{result.command ?? 'OK'}</span>
                  <span className="tabular-nums">{result.rowCount.toLocaleString()}</span>
                  {notices.length > 0 && (
                    <MessageSquareWarning className="h-3 w-3 text-amber-700 dark:text-amber-400" />
                  )}
                  {isActive && (
                    <span className="absolute inset-x-2 bottom-0 h-[2px] bg-primary" aria-hidden />
                  )}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-1 items-center px-3 font-display text-xs italic text-muted-foreground">
            Messages
          </div>
        )}
        {rows.length > 1 && (
          <button
            type="button"
            onClick={() => setMessagesOpen((v) => !v)}
            aria-expanded={messagesOpen}
            className={cn(
              'flex shrink-0 items-center gap-1.5 border-l border-border/60 px-3 text-[11px] transition-colors',
              messagesOpen
                ? 'bg-background text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
            title="Per-statement summary, notices and warnings"
          >
            <MessageSquareWarning className="h-3 w-3" />
            Messages
            {noticeCount > 0 && (
              <span className="rounded-sm bg-amber-600/15 px-1 font-mono text-[10px] text-amber-800 dark:text-amber-300">
                {noticeCount}
              </span>
            )}
          </button>
        )}
      </div>

      {showList && (
        <ul className="max-h-40 overflow-auto border-t border-border/60 px-2 py-1.5">
          {rows.map(({ index, result, notices }) => (
            <li key={index}>
              <button
                type="button"
                onClick={() => setActiveResultIndex(index)}
                className={cn(
                  'flex w-full flex-col gap-0.5 rounded-sm px-2 py-1 text-left text-[11px] transition-colors',
                  index === active
                    ? 'bg-primary/10 text-foreground'
                    : 'text-muted-foreground hover:bg-muted/80 hover:text-foreground',
                )}
              >
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 font-mono">
                  <span className="font-semibold text-foreground/80">#{index + 1}</span>
                  <span className="uppercase tracking-wide">{result.command ?? 'OK'}</span>
                  <span>· {result.rowCount.toLocaleString()} rows</span>
                  <span>· {formatDuration(result.durationMs)}</span>
                  {result.columns.length > 0 && (
                    <span className="text-muted-foreground/80">
                      · {result.columns.length} col{result.columns.length === 1 ? '' : 's'}
                    </span>
                  )}
                </div>
                {notices.map((n, ni) => (
                  <NoticeLine key={`${index}-${ni}-${n.message}`} notice={n} />
                ))}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NoticeLine({ notice }: { notice: PgNotice }) {
  const severity = (notice.severity ?? 'NOTICE').toUpperCase();
  return (
    <div className="flex items-start gap-1.5 pl-4 text-[11px] text-amber-700 dark:text-amber-400">
      <MessageSquareWarning className="mt-0.5 h-3 w-3 shrink-0" />
      <span>
        <span className="font-semibold">{severity}</span>
        {notice.code ? <span className="opacity-70"> {notice.code}</span> : null}
        {': '}
        {notice.message}
        {notice.detail ? <span className="opacity-80"> — {notice.detail}</span> : null}
        {notice.hint ? <span className="opacity-80"> (hint: {notice.hint})</span> : null}
      </span>
    </div>
  );
}

function mergeNoticeLists(a: PgNotice[] | undefined, b: PgNotice[] | undefined): PgNotice[] {
  const out: PgNotice[] = [];
  const seen = new Set<string>();
  for (const n of [...(a ?? []), ...(b ?? [])]) {
    const key = `${n.severity ?? ''}|${n.code ?? ''}|${n.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

/** Exported for tests — summarize a result the way the strip does. */
export function summarizeResult(result: QueryResult): string {
  return `${result.command ?? 'OK'} · ${result.rowCount} rows · ${result.durationMs} ms`;
}
