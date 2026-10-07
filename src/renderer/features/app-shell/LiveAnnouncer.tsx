import { useActiveTabSelect, useSession } from '@/stores/session';
import { useEffect, useRef, useState } from 'react';
import { describeQueryOutcome } from './live-announce';

/**
 * Screen-reader announcements for things that otherwise only change
 * pixels (AA7): a query finishing ("12 rows · 13 ms"), a query error,
 * connection state changes and commit failures. Visually hidden; polite
 * for status, assertive for errors.
 */
export function LiveAnnouncer() {
  const tab = useActiveTabSelect((t) =>
    t
      ? {
          id: t.id,
          queryRunState: t.queryRunState,
          phase: t.queryLifecycle?.phase,
          lifeMessage: t.queryLifecycle?.message,
          queryResult: t.queryResult,
          queryError: t.queryError,
        }
      : undefined,
  );
  const connectionState = useSession((s) => s.connectionState);
  const connName = useSession((s) => s.activeConfig?.name);
  const commitError = useSession((s) => s.pendingEditsError?.message ?? null);
  const [status, setStatus] = useState('');
  const [alert, setAlert] = useState('');
  const prevRun = useRef<{ id: string | undefined; state: string | undefined }>({
    id: undefined,
    state: undefined,
  });

  const runState = tab?.queryRunState;
  const phase = tab?.phase;
  const lifeMessage = tab?.lifeMessage;
  const tabId = tab?.id;
  const result = tab?.queryResult ?? null;
  const error = tab?.queryError ?? null;

  useEffect(() => {
    const prev = prevRun.current;
    prevRun.current = { id: tabId, state: runState };
    // Only announce a run that finished on the tab that was running.
    if (prev.id !== tabId || prev.state !== 'running' || runState === 'running') return;
    const msg = describeQueryOutcome(result, error, phase, lifeMessage);
    if (error && phase !== 'cancelled') setAlert(msg);
    else setStatus(msg);
  }, [tabId, runState, result, error, phase, lifeMessage]);

  // Cancelling is its own state: say it, so a stuck cancel is not silent.
  const prevPhase = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (phase === 'cancelling' && prevPhase.current !== 'cancelling') setStatus('Cancelling query');
    if (phase === 'queued' && prevPhase.current !== 'queued') {
      setStatus('Query queued behind another');
    }
    prevPhase.current = phase;
  }, [phase]);

  const wasConnected = useRef(false);
  useEffect(() => {
    if (connectionState === 'connected') setStatus(`Connected${connName ? ` to ${connName}` : ''}`);
    else if (connectionState === 'error') setAlert('Connection failed');
    else if (connectionState === 'idle' && wasConnected.current) setStatus('Disconnected');
    wasConnected.current = connectionState === 'connected';
  }, [connectionState, connName]);

  useEffect(() => {
    if (commitError) setAlert(`Commit failed: ${commitError}`);
  }, [commitError]);

  return (
    <>
      <output className="sr-only" aria-live="polite" data-testid="live-status">
        {status}
      </output>
      <div className="sr-only" aria-live="assertive" role="alert">
        {alert}
      </div>
    </>
  );
}
