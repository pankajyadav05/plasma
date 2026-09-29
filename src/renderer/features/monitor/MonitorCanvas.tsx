import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { EmptyState, ViewTitle, ViewToolbar } from '@/components/ui/view-parts';
import { IconButton } from '@/components/ui/workbench';
import { cn } from '@/lib/cn';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import type { ActivityRow } from '@shared/protocol';
import {
  AlertCircle,
  Copy,
  FileCode2,
  Pause,
  Play,
  RefreshCw,
  Search,
  Skull,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { filterActivity, isPlasmaSession, killSucceeded } from './monitor-filter';

const POLL_INTERVAL_MS = 2000;

const ACTIVITY_SQL = `
SELECT
  pid,
  state,
  usename                                                           AS "user",
  datname                                                           AS database,
  application_name                                                  AS application_name,
  COALESCE(client_addr::text, '')                                   AS client_addr,
  to_char(backend_start, 'YYYY-MM-DD HH24:MI:SS TZ')                AS backend_start,
  to_char(query_start,   'YYYY-MM-DD HH24:MI:SS TZ')                AS query_start,
  to_char(state_change,  'YYYY-MM-DD HH24:MI:SS TZ')                AS state_change,
  wait_event_type,
  wait_event,
  query,
  CASE
    WHEN state IN ('active') AND query_start IS NOT NULL
      THEN EXTRACT(EPOCH FROM (clock_timestamp() - query_start)) * 1000
    ELSE NULL
  END                                                               AS duration_ms,
  pid = pg_backend_pid()                                            AS is_current
FROM pg_stat_activity
WHERE backend_type = 'client backend'
ORDER BY duration_ms DESC NULLS LAST, query_start DESC NULLS LAST
`;

/**
 * Live activity monitor canvas. Polls pg_stat_activity over the
 * worker's sideband connection (so it never queues behind the user's
 * primary query). Each row exposes state, user, db, wait event, age,
 * and the query (ellipsised, full text on hover / copy / open in a tab).
 * Other sessions' queries can be cancelled (pg_cancel_backend) or
 * terminated (pg_terminate_backend); Plasma's own sessions can't.
 *
 * Defensive: polling stops while a confirm dialog is open so the row
 * the user is targeting doesn't shift out from under them.
 */
export function MonitorCanvas() {
  const setCanvasMode = useSession((s) => s.setCanvasMode);
  const reuseHistoryQuery = useSession((s) => s.reuseHistoryQuery);
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [showIdle, setShowIdle] = useState(true);
  const [showSelf, setShowSelf] = useState(false);
  const [search, setSearch] = useState('');
  const [database, setDatabase] = useState<string>('all');
  const [terminating, setTerminating] = useState<{
    pid: number;
    mode: 'cancel' | 'terminate';
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastPoll, setLastPoll] = useState<number | null>(null);
  const pollGuard = useRef(false);

  const refresh = async () => {
    if (pollGuard.current) return;
    pollGuard.current = true;
    try {
      const res = await ipc.query.sideband(ACTIVITY_SQL);
      const next: ActivityRow[] = res.rows.map((r) => ({
        pid: Number(r[0] ?? 0),
        state: (r[1] as string | null) ?? null,
        user: (r[2] as string | null) ?? null,
        database: (r[3] as string | null) ?? null,
        applicationName: (r[4] as string | null) ?? null,
        clientAddr: (r[5] as string | null) ?? null,
        backendStart: (r[6] as string | null) ?? null,
        queryStart: (r[7] as string | null) ?? null,
        stateChange: (r[8] as string | null) ?? null,
        waitEventType: (r[9] as string | null) ?? null,
        waitEvent: (r[10] as string | null) ?? null,
        query: (r[11] as string | null) ?? null,
        durationMs: r[12] !== null && r[12] !== undefined ? Number(r[12]) : null,
        isCurrent: r[13] === true || r[13] === 't' || r[13] === 1,
      }));
      setRows(next);
      setError(null);
      setLastPoll(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      pollGuard.current = false;
    }
  };

  // `refresh` is recreated on every render but its identity doesn't matter —
  // pollGuard already serializes calls. Including it would re-arm setInterval
  // every poll, which is exactly what we don't want.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is stable in behavior
  useEffect(() => {
    void refresh();
    if (paused || terminating) return;
    const t = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [paused, terminating]);

  const databases = useMemo(
    () => [...new Set(rows.map((r) => r.database).filter((d): d is string => Boolean(d)))].sort(),
    [rows],
  );

  const visibleRows = filterActivity(rows, {
    showIdle,
    showSelf,
    search,
    database: database === 'all' ? null : database,
  });

  const onConfirmKill = async () => {
    if (!terminating) return;
    setBusy(true);
    setNotice(null);
    try {
      const fn = terminating.mode === 'terminate' ? 'pg_terminate_backend' : 'pg_cancel_backend';
      const res = await ipc.query.sideband(`SELECT ${fn}($1)`, [terminating.pid]);
      // H3: these functions return false (not an error) when the backend
      // is gone or you lack permission — say so instead of implying success.
      if (killSucceeded(res.rows)) {
        setNotice(
          terminating.mode === 'terminate'
            ? `Terminated pid ${terminating.pid}.`
            : `Sent cancel to pid ${terminating.pid}.`,
        );
      } else {
        setError(
          `Postgres did not ${terminating.mode} pid ${terminating.pid} — the session has ended, or your role lacks permission (pg_signal_backend or superuser).`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setTerminating(null);
      void refresh();
    }
  };

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--wb-content)]">
      <ViewToolbar>
        <ViewTitle
          title="Live activity"
          meta={
            <>
              {visibleRows.length} of {rows.length} sessions
              {lastPoll && ` · updated ${fmtAgo(lastPoll)}`}
              {paused && ' · paused'}
            </>
          }
        />
        <div className="flex-1" />
        <IconButton variant="plain" label="Refresh now" onClick={() => void refresh()}>
          <RefreshCw className={busy ? 'animate-spin' : ''} />
        </IconButton>
        <IconButton
          variant="plain"
          label={paused ? 'Resume polling' : 'Pause polling'}
          active={paused}
          onClick={() => setPaused((v) => !v)}
        >
          {paused ? <Play /> : <Pause />}
        </IconButton>
        <IconButton
          variant="plain"
          label="Close monitor"
          title="Close (Esc)"
          onClick={() => setCanvasMode('database')}
        >
          <X />
        </IconButton>
      </ViewToolbar>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--wb-separator)] px-2.5 py-2">
        <div className="relative min-w-[200px] max-w-[360px] flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--wb-text-2)]" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by query, user, app or pid…"
            aria-label="Filter sessions"
            className="pl-7"
          />
        </div>
        <Select value={database} onValueChange={setDatabase}>
          <SelectTrigger className="w-[180px]" aria-label="Database">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All databases</SelectItem>
            {databases.map((d) => (
              <SelectItem key={d} value={d}>
                {d}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1.5">
          <Checkbox
            id="mon-show-idle"
            checked={showIdle}
            onCheckedChange={(v) => setShowIdle(v === true)}
          />
          <label
            htmlFor="mon-show-idle"
            className="cursor-pointer text-[13px] text-[var(--wb-text)]"
          >
            Idle sessions
          </label>
        </div>
        <div className="flex items-center gap-1.5">
          <Checkbox
            id="mon-show-self"
            checked={showSelf}
            onCheckedChange={(v) => setShowSelf(v === true)}
          />
          <label
            htmlFor="mon-show-self"
            className="cursor-pointer text-[13px] text-[var(--wb-text)]"
          >
            This monitor
          </label>
        </div>
      </div>

      {error && (
        <div
          className="flex shrink-0 items-center gap-2 border-b border-[var(--wb-separator)] bg-[color-mix(in_srgb,var(--destructive)_10%,transparent)] px-3 py-1.5 text-[12px] text-destructive"
          role="alert"
        >
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
          <IconButton variant="plain" label="Dismiss" onClick={() => setError(null)}>
            <X />
          </IconButton>
        </div>
      )}
      <div className="sr-only" aria-live="polite">
        {notice}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full table-fixed text-[12px]">
          <thead className="sticky top-0 z-10 bg-[var(--wb-content)]">
            <tr className="text-left text-[12px] font-medium text-[var(--wb-text-2)]">
              <Th width={80}>PID</Th>
              <Th width={110}>State</Th>
              <Th width={110}>User</Th>
              <Th width={120}>Database</Th>
              <Th width={150}>Wait</Th>
              <Th width={80}>Age</Th>
              <Th>Query</Th>
              <Th width={112}>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((r, i) => {
              const own = r.isCurrent || isPlasmaSession(r);
              const oneLine = r.query?.replace(/\s+/g, ' ').trim() ?? '';
              return (
                <tr
                  key={r.pid}
                  className={cn(
                    'group/act align-top font-mono',
                    i % 2 === 1 && 'bg-[var(--grid-row-a)]',
                  )}
                >
                  <Td>
                    {r.pid}
                    {r.isCurrent && (
                      <span className="ml-1 rounded-[4px] bg-[var(--wb-control)] px-1 font-sans text-[10px] text-[var(--wb-text-2)]">
                        this
                      </span>
                    )}
                  </Td>
                  <Td>
                    <StateBadge state={r.state} />
                  </Td>
                  <Td title={r.user ?? undefined}>{r.user ?? '—'}</Td>
                  <Td title={r.database ?? undefined}>{r.database ?? '—'}</Td>
                  <Td title={r.waitEvent ? `${r.waitEventType}:${r.waitEvent}` : undefined}>
                    {r.waitEvent ? (
                      <span className="text-[var(--wb-text-2)]">
                        {r.waitEventType}:{r.waitEvent}
                      </span>
                    ) : (
                      <span className="text-[var(--wb-text-3)]">—</span>
                    )}
                  </Td>
                  <Td>{fmtMs(r.durationMs)}</Td>
                  <Td title={r.query ?? undefined}>
                    <span className="block truncate text-[var(--wb-text)]">{oneLine || '—'}</span>
                    {r.applicationName && (
                      <span className="block truncate font-sans text-[11px] text-[var(--wb-text-3)]">
                        {r.applicationName}
                        {r.clientAddr ? ` · ${r.clientAddr}` : ''}
                      </span>
                    )}
                  </Td>
                  <td className="px-2 py-1">
                    <div className="flex justify-end gap-0.5">
                      <IconButton
                        variant="plain"
                        label={`Copy query of pid ${r.pid}`}
                        title="Copy query"
                        disabled={!r.query}
                        onClick={() => void navigator.clipboard?.writeText(r.query ?? '')}
                      >
                        <Copy />
                      </IconButton>
                      <IconButton
                        variant="plain"
                        label={`Open query of pid ${r.pid} in a new SQL tab`}
                        title="Open in a new SQL tab"
                        disabled={!r.query}
                        onClick={() => r.query && reuseHistoryQuery(r.query)}
                      >
                        <FileCode2 />
                      </IconButton>
                      <IconButton
                        variant="plain"
                        label={`Cancel query of pid ${r.pid}`}
                        title={
                          own
                            ? "Plasma's own session — cancel it from the editor"
                            : 'Cancel query (pg_cancel_backend)'
                        }
                        disabled={own}
                        onClick={() => setTerminating({ pid: r.pid, mode: 'cancel' })}
                      >
                        <X />
                      </IconButton>
                      <IconButton
                        variant="plain"
                        label={`Terminate session ${r.pid}`}
                        title={
                          own
                            ? "Plasma's own session — disconnect instead"
                            : 'Terminate session (pg_terminate_backend)'
                        }
                        disabled={own}
                        className="hover:text-destructive"
                        onClick={() => setTerminating({ pid: r.pid, mode: 'terminate' })}
                      >
                        <Skull />
                      </IconButton>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {visibleRows.length === 0 && (
          <EmptyState
            title={rows.length === 0 ? 'No activity' : 'No sessions match'}
            hint={rows.length === 0 ? undefined : 'Clear the filter or show idle sessions.'}
          />
        )}
      </div>

      <ConfirmDialog
        open={Boolean(terminating)}
        onOpenChange={(v) => !v && setTerminating(null)}
        title={
          terminating?.mode === 'terminate'
            ? `Terminate session ${terminating?.pid}?`
            : `Cancel the query of session ${terminating?.pid}?`
        }
        description={
          terminating?.mode === 'terminate'
            ? 'pg_terminate_backend closes the connection. Any open transaction rolls back.'
            : 'pg_cancel_backend asks the backend to stop its current query. The connection stays open.'
        }
        confirmLabel={terminating?.mode === 'terminate' ? 'Terminate' : 'Cancel query'}
        variant="destructive"
        onConfirm={() => void onConfirmKill()}
      />
    </main>
  );
}

function Th({ children, width }: { children?: React.ReactNode; width?: number }) {
  return (
    <th
      style={{ width: width ? `${width}px` : undefined }}
      className="h-[26px] border-b border-[var(--wb-separator)] px-2 font-medium"
    >
      {children}
    </th>
  );
}

function Td({ children, title }: { children?: React.ReactNode; title?: string }) {
  return (
    <td className="overflow-hidden truncate px-2 py-1 text-[var(--wb-text)]" title={title}>
      {children}
    </td>
  );
}

function StateBadge({ state }: { state: string | null }) {
  if (!state) return <span className="text-[var(--wb-text-3)]">—</span>;
  const map: Record<string, string> = {
    active: 'bg-[color-mix(in_srgb,var(--status-warn)_18%,transparent)] text-[var(--wb-text)]',
    idle: 'bg-[var(--wb-control)] text-[var(--wb-text-2)]',
    'idle in transaction':
      'bg-[color-mix(in_srgb,var(--status-staging)_30%,transparent)] text-[var(--wb-text)]',
    'idle in transaction (aborted)':
      'bg-[color-mix(in_srgb,var(--destructive)_20%,transparent)] text-[var(--wb-text)]',
  };
  const cls = map[state] ?? 'bg-[var(--wb-control)] text-[var(--wb-text-2)]';
  return (
    <span className={cn('rounded-[4px] px-1.5 py-0.5 font-sans text-[11px]', cls)} title={state}>
      {state.replace('idle in transaction', 'idle in txn')}
    </span>
  );
}

function fmtMs(v: number | null): string {
  if (v == null) return '—';
  if (v < 1000) return `${v.toFixed(0)}ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(1)}s`;
  if (v < 3_600_000) return `${(v / 60_000).toFixed(1)}m`;
  return `${(v / 3_600_000).toFixed(1)}h`;
}

function fmtAgo(ts: number): string {
  const d = Date.now() - ts;
  if (d < 1500) return 'now';
  return `${Math.round(d / 1000)}s ago`;
}
