import { cn } from '@/lib/cn';
import { formatDuration } from '@/lib/format';
import { useActiveTab, useSession } from '@/stores/session';
import type { PgNotice, QueryResult } from '@shared/protocol';
import { ChevronLeft, ChevronRight, MessageSquareWarning } from 'lucide-react';
import { useEffect, useMemo } from 'react';

/**
 * U26 — compact statement switcher + messages strip below the result toolbar.
 *
 * Lists every statement from the last multi-result run with command, row
 * count, duration, and any NOTICE/WARNING lines. Click (or ⌥←/→) to focus
 * that statement's grid. Single-result runs collapse to a one-line summary
 * when notices are present; otherwise the strip stays hidden.
 */
export function ResultMessagesStrip() {
  const tab = useActiveTab();
  const setActiveResultIndex = useSession((s) => s.setActiveResultIndex);
  const cycleActiveResult = useSession((s) => s.cycleActiveResult);

  const results = tab?.queryResults ?? [];
  const active = tab?.activeResultIndex ?? 0;
  const streamingNotices = tab?.queryNotices ?? [];
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

  if (!tab || !isSql) return null;
  // Hide entirely for a lone result with no notices.
  if (rows.length === 0) return null;
  if (rows.length === 1 && (rows[0]?.notices.length ?? 0) === 0) return null;

  return (
    <div className="flex shrink-0 flex-col border-b bg-muted/30">
      {rows.length > 1 && (
        <div className="flex h-8 items-center gap-1 border-b border-border/60 px-2">
          <button
            type="button"
            className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
            title="Previous result (⌥←)"
            disabled={active <= 0}
            onClick={() => setActiveResultIndex(active - 1)}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span className="min-w-[4.5rem] text-center font-mono text-[11px] text-muted-foreground">
            {active + 1} / {rows.length}
          </span>
          <button
            type="button"
            className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
            title="Next result (⌥→)"
            disabled={active >= rows.length - 1}
            onClick={() => setActiveResultIndex(active + 1)}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
          <span className="ml-2 truncate text-[11px] text-muted-foreground">
            Statement results · ⌥←/→ to switch
          </span>
        </div>
      )}

      <ul className="max-h-28 overflow-auto px-2 py-1.5">
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

function mergeNoticeLists(
  a: PgNotice[] | undefined,
  b: PgNotice[] | undefined,
): PgNotice[] {
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
