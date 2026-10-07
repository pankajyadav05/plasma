import { Pill } from '@/components/ui/workbench';
import { cleanIpcError } from '@/lib/errors';
import { useSession } from '@/stores/session';
import {
  CANCEL_STUCK_MS,
  type QueryLifecycle,
  cancelIsStuck,
  formatElapsed,
  isBusyPhase,
  phaseLabel,
  writeTarget,
} from '@shared/query-lifecycle';
import { AlertCircle, AlertTriangle, Ban, Loader2, PlugZap, Search } from 'lucide-react';
import { useEffect, useState } from 'react';

export { formatElapsed };

/** Re-render every `ms` while `active`; returns the current time. */
export function useNow(active: boolean, ms = 100): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return now;
}

/** Elapsed time of a busy run (from when it started executing, or queued). */
export function runElapsed(l: QueryLifecycle, now: number): number {
  return Math.max(0, now - (l.startedAt ?? l.since));
}

/**
 * Results pane while a SQL run has produced nothing yet (VF20, C1): the pane
 * keeps its place and says what is happening, with the elapsed time ticking.
 */
export function RunProgressPanel({ lifecycle }: { lifecycle: QueryLifecycle }) {
  const now = useNow(isBusyPhase(lifecycle.phase));
  const disconnect = useSession((s) => s.disconnect);
  const cancelQuery = useSession((s) => s.cancelQuery);
  const { phase } = lifecycle;
  const stuck = cancelIsStuck(lifecycle, now);
  const title =
    phase === 'queued'
      ? 'Waiting for the connection'
      : phase === 'cancelling'
        ? 'Cancelling'
        : 'Running';
  const detail =
    phase === 'queued'
      ? 'Another query is using this connection. This one starts when it finishes.'
      : phase === 'cancelling'
        ? stuck
          ? `The server has not stopped it after ${Math.round(CANCEL_STUCK_MS / 1000)}s.`
          : 'Cancel sent. Waiting for the server to stop it.'
        : null;
  return (
    <div
      className="grid min-h-0 flex-1 place-items-center bg-[var(--wb-content)]"
      data-testid="query-running"
      data-phase={phase}
      aria-live="polite"
    >
      <div className="flex flex-col items-center gap-1.5 text-[13px] text-[var(--wb-text-2)]">
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          <span>
            {title}…{' '}
            <span
              className="font-mono tabular-nums text-[var(--wb-text)]"
              data-testid="query-elapsed"
            >
              {formatElapsed(runElapsed(lifecycle, now))}
            </span>
          </span>
        </div>
        {detail && <div className="max-w-[360px] text-center text-[12px]">{detail}</div>}
        {lifecycle.cancelNote && (
          <div className="max-w-[360px] text-center text-[12px] text-[var(--status-warn)]">
            {lifecycle.cancelNote}
          </div>
        )}
        {phase === 'cancelling' && (stuck || lifecycle.cancelNote) && (
          <div className="mt-1 flex items-center gap-2">
            <Pill onClick={() => void cancelQuery()} data-testid="cancel-again">
              Cancel again
            </Pill>
            <Pill onClick={() => void disconnect()} data-testid="disconnect-to-stop">
              Disconnect to stop it
            </Pill>
          </div>
        )}
      </div>
    </div>
  );
}

/** Small state chip for the result footer: state, elapsed. */
export function RunStatusChip({
  lifecycle,
  settledText,
}: {
  lifecycle: QueryLifecycle | undefined;
  /** Duration text shown for a succeeded run. */
  settledText?: string | null;
}) {
  const busy = lifecycle ? isBusyPhase(lifecycle.phase) : false;
  const now = useNow(busy);
  const cancelQuery = useSession((s) => s.cancelQuery);
  const disconnect = useSession((s) => s.disconnect);
  if (!lifecycle || lifecycle.phase === 'idle') return null;
  const { phase } = lifecycle;
  const stuck = cancelIsStuck(lifecycle, now) || Boolean(lifecycle.cancelNote);
  if (phase === 'succeeded') {
    return settledText ? (
      <span
        className="ml-1.5 shrink-0 text-[13px] tabular-nums text-[var(--wb-text-2)] @max-[520px]:hidden"
        data-testid="run-status"
        data-phase={phase}
      >
        {settledText}
      </span>
    ) : null;
  }
  const tone =
    phase === 'failed'
      ? 'text-destructive'
      : phase === 'unknown' || phase === 'disconnected' || phase === 'cancelling'
        ? 'text-[var(--status-warn)]'
        : 'text-[var(--wb-text-2)]';
  return (
    <span
      className={`ml-1.5 flex shrink-0 items-center gap-1.5 text-[13px] tabular-nums ${tone}`}
      data-testid="run-status"
      data-phase={phase}
    >
      {busy && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
      {phaseLabel(phase)}
      {busy && <span className="font-mono">{formatElapsed(runElapsed(lifecycle, now))}</span>}
      {!busy && lifecycle.elapsedMs != null && (
        <span className="font-mono">{formatElapsed(lifecycle.elapsedMs)}</span>
      )}
      {phase === 'cancelling' && stuck && (
        <>
          <button
            type="button"
            onClick={() => void cancelQuery()}
            data-testid="chip-cancel-again"
            className="underline-offset-2 hover:underline"
          >
            Cancel again
          </button>
          <button
            type="button"
            onClick={() => void disconnect()}
            data-testid="chip-disconnect-to-stop"
            className="underline-offset-2 hover:underline"
            title={lifecycle.cancelNote ?? 'Drop the connection to stop the statement'}
          >
            Disconnect to stop it
          </button>
        </>
      )}
    </span>
  );
}

const PANELS = {
  failed: { title: 'Query failed', tone: 'error', Icon: AlertCircle },
  cancelled: { title: 'Cancelled', tone: 'neutral', Icon: Ban },
  disconnected: { title: 'Connection dropped', tone: 'warn', Icon: PlugZap },
  unknown: { title: 'Outcome unknown', tone: 'warn', Icon: AlertTriangle },
} as const;

const TONE_CLASS = {
  error: 'bg-destructive/10 ring-destructive/30',
  neutral: 'bg-[var(--wb-field)] ring-[var(--wb-separator)]',
  warn: 'bg-[color-mix(in_srgb,var(--status-warn)_12%,transparent)] ring-[color-mix(in_srgb,var(--status-warn)_40%,transparent)]',
} as const;

const TONE_TEXT = {
  error: 'text-destructive',
  neutral: 'text-[var(--wb-text-2)]',
  warn: 'text-[var(--status-warn)]',
} as const;

/**
 * The finished-badly panel (C1): failed, cancelled, connection dropped, and
 * the write whose outcome never came back, each with what to do next.
 */
export function RunOutcomePanel({
  lifecycle,
  error,
  tabId,
  children,
}: {
  lifecycle: QueryLifecycle | undefined;
  error: string;
  tabId: string;
  children?: React.ReactNode;
}) {
  const phase = lifecycle?.phase;
  const spec = phase && phase in PANELS ? PANELS[phase as keyof typeof PANELS] : PANELS.failed;
  const openTable = useSession((s) => s.openTable);
  const defaultSchema = useSession((s) => s.currentSchema ?? 'public');
  const reconnecting = useSession((s) => s.connectionState !== 'connected');
  const target = phase === 'unknown' && lifecycle?.sql ? writeTarget(lifecycle.sql) : null;
  const text = cleanIpcError(
    phase === 'unknown' || phase === 'disconnected' ? (lifecycle?.message ?? error) : error,
  );
  return (
    <div
      className={`flex items-start gap-2.5 rounded-[8px] px-3.5 py-3 ring-1 ring-inset ${TONE_CLASS[spec.tone]}`}
      role={spec.tone === 'neutral' ? 'status' : 'alert'}
      data-testid="run-outcome"
      data-phase={phase ?? 'failed'}
      data-tab={tabId}
    >
      <spec.Icon className={`mt-0.5 h-4 w-4 shrink-0 ${TONE_TEXT[spec.tone]}`} aria-hidden />
      <div className="min-w-0">
        <div className={`mb-1 text-xs font-semibold ${TONE_TEXT[spec.tone]}`}>{spec.title}</div>
        <pre className="whitespace-pre-wrap break-words font-mono text-[13px] text-[var(--wb-text)]">
          {text}
        </pre>
        {phase === 'unknown' && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-[var(--wb-text-2)]">
            <span>Nothing was re-run. Look at the data before you run it again.</span>
            {target ? (
              <Pill
                onClick={() =>
                  openTable(target.schema ?? defaultSchema, target.table, {
                    newTab: true,
                    preview: false,
                  })
                }
                disabled={reconnecting}
                data-testid="check-the-data"
              >
                <Search />
                Check the data
              </Pill>
            ) : (
              <span data-testid="check-the-data-hint">
                Query the tables this statement touches to see whether it landed.
              </span>
            )}
          </div>
        )}
        {phase === 'disconnected' && (
          <div className="mt-1.5 text-[12px] text-[var(--wb-text-2)]">
            Run it again once the connection is back.
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
