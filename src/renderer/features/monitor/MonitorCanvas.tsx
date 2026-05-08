import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { cn } from '@/lib/cn';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import type { ActivityRow } from '@shared/protocol';
import { Activity, AlertCircle, Pause, Play, RefreshCw, Skull, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

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
 * and a one-line query preview. Active queries can be cancelled
 * (pg_cancel_backend) or terminated (pg_terminate_backend).
 *
 * Defensive: polling stops while a confirm dialog is open so the row
 * the user is targeting doesn't shift out from under them.
 */
export function MonitorCanvas() {
  const setCanvasMode = useSession((s) => s.setCanvasMode);
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [showIdle, setShowIdle] = useState(true);
  const [showSelf, setShowSelf] = useState(false);
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

  const visibleRows = rows.filter((r) => {
    if (!showSelf && r.isCurrent) return false;
    if (!showIdle && r.state === 'idle') return false;
    return true;
  });

  const onConfirmKill = async () => {
    if (!terminating) return;
    setBusy(true);
    try {
      const fn = terminating.mode === 'terminate' ? 'pg_terminate_backend' : 'pg_cancel_backend';
      await ipc.query.sideband(`SELECT ${fn}($1)`, [terminating.pid]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setTerminating(null);
      void refresh();
    }
  };

  return (
    <main className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
        <Activity className="h-4 w-4 text-primary" />
        <span className="font-display text-sm italic text-foreground">Live activity</span>
        <span
          className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground"
          title="Connections shown"
        >
          {visibleRows.length}/{rows.length}
        </span>
        {lastPoll && (
          <span
            className="font-display text-[11px] italic text-muted-foreground"
            title="Last refresh"
          >
            updated {fmtAgo(lastPoll)}
          </span>
        )}
        <div className="flex-1" />
        <label
          htmlFor="mon-show-idle"
          className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"
        >
          <Checkbox
            id="mon-show-idle"
            checked={showIdle}
            onCheckedChange={(v) => setShowIdle(Boolean(v))}
          />
          idle
        </label>
        <label
          htmlFor="mon-show-self"
          className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"
        >
          <Checkbox
            id="mon-show-self"
            checked={showSelf}
            onCheckedChange={(v) => setShowSelf(Boolean(v))}
          />
          self
        </label>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => void refresh()}
          title="Refresh now"
          aria-label="Refresh"
        >
          <RefreshCw className={busy ? 'animate-spin' : ''} />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setPaused((v) => !v)}
          title={paused ? 'Resume polling' : 'Pause polling'}
          aria-label="Pause/resume"
        >
          {paused ? <Play /> : <Pause />}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setCanvasMode('database')}
          title="Close monitor"
          aria-label="Close"
        >
          <X />
        </Button>
      </div>

      {error && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-destructive/10 px-3 py-2 font-mono text-xs text-destructive">
          <AlertCircle className="h-3.5 w-3.5" />
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full table-fixed font-mono text-[12px]">
          <thead className="sticky top-0 z-10 bg-background">
            <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
              <Th width={70}>pid</Th>
              <Th width={90}>state</Th>
              <Th width={100}>user</Th>
              <Th width={120}>db</Th>
              <Th width={140}>wait</Th>
              <Th width={90}>age</Th>
              <Th>query</Th>
              <Th width={88} />
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((r) => (
              <tr
                key={r.pid}
                className={cn(
                  'border-b border-border/60 align-top hover:bg-accent/20',
                  r.isCurrent && 'bg-primary/5',
                  r.state === 'active' && !r.isCurrent && 'bg-amber-500/5',
                )}
              >
                <Td>
                  {r.pid}
                  {r.isCurrent && (
                    <span className="ml-1 rounded-sm border border-primary/40 bg-primary/10 px-1 text-[9px] text-primary">
                      self
                    </span>
                  )}
                </Td>
                <Td>
                  <StateBadge state={r.state} />
                </Td>
                <Td>{r.user ?? '—'}</Td>
                <Td>{r.database ?? '—'}</Td>
                <Td>
                  {r.waitEvent ? (
                    <span className="text-muted-foreground">
                      {r.waitEventType}:{r.waitEvent}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/50">—</span>
                  )}
                </Td>
                <Td>{fmtMs(r.durationMs)}</Td>
                <Td>
                  <pre
                    className="overflow-hidden whitespace-nowrap text-foreground"
                    title={r.query ?? ''}
                  >
                    {r.query?.replace(/\s+/g, ' ').slice(0, 240) ?? '—'}
                  </pre>
                </Td>
                <Td>
                  {!r.isCurrent && (
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => setTerminating({ pid: r.pid, mode: 'cancel' })}
                        title="pg_cancel_backend"
                        aria-label="Cancel"
                      >
                        <X />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="text-destructive hover:bg-destructive/10"
                        onClick={() => setTerminating({ pid: r.pid, mode: 'terminate' })}
                        title="pg_terminate_backend"
                        aria-label="Terminate"
                      >
                        <Skull />
                      </Button>
                    </div>
                  )}
                </Td>
              </tr>
            ))}
            {visibleRows.length === 0 && (
              <tr>
                <td
                  colSpan={8}
                  className="px-3 py-8 text-center font-display italic text-muted-foreground"
                >
                  no activity
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={Boolean(terminating)}
        onOpenChange={(v) => !v && setTerminating(null)}
        title={
          terminating?.mode === 'terminate'
            ? `Terminate pid ${terminating?.pid}?`
            : `Cancel pid ${terminating?.pid}?`
        }
        description={
          terminating?.mode === 'terminate'
            ? 'pg_terminate_backend will close the connection. Any in-progress transaction will roll back.'
            : 'pg_cancel_backend asks the backend to abort its current query. Connection stays open.'
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
      className="sticky top-0 z-10 border-b border-border bg-background px-2 py-1.5 font-display"
    >
      {children}
    </th>
  );
}

function Td({ children }: { children?: React.ReactNode }) {
  return <td className="overflow-hidden truncate px-2 py-1.5 align-top">{children}</td>;
}

function StateBadge({ state }: { state: string | null }) {
  if (!state) return <span className="text-muted-foreground/50">—</span>;
  const map: Record<string, string> = {
    active: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
    idle: 'bg-muted text-muted-foreground',
    'idle in transaction': 'bg-orange-500/15 text-orange-700 dark:text-orange-300',
    'idle in transaction (aborted)': 'bg-destructive/15 text-destructive',
  };
  const cls = map[state] ?? 'bg-muted text-muted-foreground';
  return (
    <span className={cn('rounded-sm px-1.5 py-0.5 text-[10px] uppercase tracking-wider', cls)}>
      {state.replace('idle in transaction', 'idle-txn')}
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
