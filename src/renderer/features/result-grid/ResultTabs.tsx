import { cn } from '@/lib/cn';
import { cleanIpcError } from '@/lib/errors';
import { formatDuration } from '@/lib/format';
import { useActiveTab, useSession } from '@/stores/session';
import type { PgNotice, QueryResult } from '@shared/protocol';
import { AlertCircle, CheckCircle2, MessageSquareWarning } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { hasPartialResults, hideErrorTab, isErrorTabActive, showErrorTab } from './result-view';

type StatementRow = { index: number; result: QueryResult; notices: PgNotice[] };

/** Per-statement results with streamed notices merged in (U26). */
function useStatementRows(): StatementRow[] {
  const tab = useActiveTab();
  const results: QueryResult[] = tab?.queryResults ?? [];
  const streamingNotices: Array<{ statementIndex: number; notice: PgNotice }> =
    tab?.queryNotices ?? [];
  return useMemo(
    () =>
      results.map((r, i) => {
        const streamed = streamingNotices
          .filter((n) => n.statementIndex === i)
          .map((n) => n.notice);
        return { index: i, result: r, notices: mergeNoticeLists(r.notices, streamed) };
      }),
    [results, streamingNotices],
  );
}

/**
 * Result tabs above the grid — one per statement of a multi-statement
 * run (TablePlus "split results into tabs"). Click or ⌥←/→ focuses a
 * statement. Hidden for single-statement runs. When a script fails
 * part-way, the failure gets its own "Error" tab and the statements that
 * succeeded stay reachable (E6 / VF4).
 */
export function ResultTabs() {
  const tab = useActiveTab();
  const setActiveResultIndex = useSession((s) => s.setActiveResultIndex);
  const cycleActiveResult = useSession((s) => s.cycleActiveResult);
  const rows = useStatementRows();
  const active = tab?.activeResultIndex ?? 0;
  const isSql = tab?.kind === 'sql';
  const partial = hasPartialResults(tab);
  const errorActive = isErrorTabActive(tab);
  const multi = isSql && (rows.length > 1 || partial);
  const selectResult = (index: number) => {
    setActiveResultIndex(index);
    if (tab && partial) hideErrorTab(tab);
  };

  // ⌥← / ⌥→ cycle statements while focus is outside Monaco (Monaco owns
  // those chords inside the editor). Alt alone only — ⌘⌥← is history.
  useEffect(() => {
    if (!multi) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      if (target?.classList?.contains('inputarea')) return;
      e.preventDefault();
      cycleActiveResult(e.key === 'ArrowLeft' ? -1 : 1);
      const t = useSession.getState().tabs.find((x) => x.id === useSession.getState().activeTabId);
      if (t && hasPartialResults(t)) hideErrorTab(t);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [multi, cycleActiveResult]);

  if (!multi) return null;

  return (
    <div className="flex h-[34px] shrink-0 items-stretch border-b border-[var(--wb-separator)] bg-[var(--wb-tabbar)]">
      <div
        className="scrollbar-none flex min-w-0 flex-1 items-stretch gap-1 overflow-x-auto px-1 py-1"
        role="tablist"
        aria-label="Statement results · ⌥←/→ to switch"
      >
        {rows.map(({ index, result, notices }) => {
          const isActive = index === active && !errorActive;
          return (
            <button
              key={index}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => selectResult(index)}
              title={`${summarizeResult(result)} — ⌥←/→ to switch`}
              className={cn(
                'flex min-w-[120px] flex-1 items-center justify-center gap-1.5 rounded-[7px] px-3 text-[13px] transition-colors',
                isActive
                  ? 'bg-[var(--wb-control-active)] text-[var(--wb-text)]'
                  : 'text-[var(--wb-text-2)] hover:bg-[var(--wb-control-hover)] hover:text-[var(--wb-text)]',
              )}
            >
              <span>Result {index + 1}</span>
              <span className="font-mono text-[12px] opacity-60">
                {result.command ?? 'OK'} {result.rowCount.toLocaleString()}
              </span>
              {notices.length > 0 && (
                <MessageSquareWarning className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
              )}
            </button>
          );
        })}
        {partial && tab && (
          <button
            type="button"
            role="tab"
            aria-selected={errorActive}
            onClick={() => showErrorTab(tab)}
            title={cleanIpcError(tab.queryError ?? '')}
            data-testid="result-tab-error"
            className={cn(
              'flex min-w-[120px] flex-1 items-center justify-center gap-1.5 rounded-[7px] px-3 text-[13px] transition-colors',
              errorActive
                ? 'bg-[var(--wb-control-active)] text-[var(--wb-text)]'
                : 'text-[var(--wb-text-2)] hover:bg-[var(--wb-control-hover)] hover:text-[var(--wb-text)]',
            )}
          >
            <AlertCircle className="h-3.5 w-3.5 text-destructive" />
            <span>Error</span>
            <span className="font-mono text-[12px] opacity-60">statement {rows.length + 1}</span>
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The footer's "Message" view: every statement with its command, row
 * count and timing, NOTICE/WARNING lines, and the error if the run
 * failed. Clicking a statement focuses its result.
 */
export function ResultMessagesPanel() {
  const tab = useActiveTab();
  const setActiveResultIndex = useSession((s) => s.setActiveResultIndex);
  const rows = useStatementRows();
  const active = tab?.activeResultIndex ?? 0;

  if (!tab) return null;

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-[var(--wb-content)] px-3 py-2 text-[13px] text-[var(--wb-text)]">
      {rows.length === 0 && !tab.queryError && (
        <div className="px-2 py-3 text-[var(--wb-text-2)]">No messages — run a query first.</div>
      )}
      {rows.map(({ index, result, notices }) => (
        <button
          key={index}
          type="button"
          onClick={() => {
            setActiveResultIndex(index);
            if (hasPartialResults(tab)) hideErrorTab(tab);
          }}
          className={cn(
            'mb-1 flex w-full flex-col gap-1 rounded-[6px] px-2.5 py-2 text-left transition-colors',
            index === active ? 'bg-[var(--wb-selected)]' : 'hover:bg-[var(--wb-control)]',
          )}
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <CheckCircle2 className="h-3.5 w-3.5 text-[var(--wb-accent)]" />
            <span className="font-semibold text-[var(--wb-text)]">Result {index + 1}</span>
            <span className="font-mono text-[12px] text-[var(--wb-text-2)]">
              {result.command ?? 'OK'}
            </span>
            <span className="text-[var(--wb-text-2)]">
              · {result.rowCount.toLocaleString()} rows · {formatDuration(result.durationMs)}
              {result.columns.length > 0 &&
                ` · ${result.columns.length} col${result.columns.length === 1 ? '' : 's'}`}
              {result.truncated && ' · limited'}
            </span>
          </div>
          {notices.map((n, ni) => (
            <NoticeLine key={`${index}-${ni}-${n.message}`} notice={n} />
          ))}
        </button>
      ))}
      {tab.queryError && (
        <div className="flex items-start gap-2 rounded-[6px] bg-destructive/10 px-2.5 py-2 text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <pre className="whitespace-pre-wrap break-words font-mono text-[12px]">
            {cleanIpcError(tab.queryError)}
          </pre>
        </div>
      )}
    </div>
  );
}

/** Count of NOTICE/WARNING lines across the last run (footer badge). */
export function useNoticeCount(): number {
  return useStatementRows().reduce((n, r) => n + r.notices.length, 0);
}

function NoticeLine({ notice }: { notice: PgNotice }) {
  const severity = (notice.severity ?? 'NOTICE').toUpperCase();
  return (
    <div className="flex items-start gap-1.5 pl-5 font-mono text-[12px] text-amber-700 dark:text-amber-400">
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

/** Summarize a result the way the result tabs do. */
export function summarizeResult(result: QueryResult): string {
  return `${result.command ?? 'OK'} · ${result.rowCount} rows · ${result.durationMs} ms`;
}
