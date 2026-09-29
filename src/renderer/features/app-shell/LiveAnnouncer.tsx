import { useActiveTab, useSession } from '@/stores/session';
import { useEffect, useRef, useState } from 'react';
import { describeQueryOutcome } from './live-announce';

/**
 * Screen-reader announcements for things that otherwise only change
 * pixels (AA7): a query finishing ("12 rows · 13 ms"), a query error,
 * connection state changes and commit failures. Visually hidden; polite
 * for status, assertive for errors.
 */
export function LiveAnnouncer() {
  const tab = useActiveTab();
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
  const tabId = tab?.id;
  const result = tab?.queryResult ?? null;
  const error = tab?.queryError ?? null;

  useEffect(() => {
    const prev = prevRun.current;
    prevRun.current = { id: tabId, state: runState };
    // Only announce a run that finished on the tab that was running.
    if (prev.id !== tabId || prev.state !== 'running' || runState === 'running') return;
    const msg = describeQueryOutcome(result, error);
    if (error) setAlert(msg);
    else setStatus(msg);
  }, [tabId, runState, result, error]);

  useEffect(() => {
    if (connectionState === 'connected') setStatus(`Connected${connName ? ` to ${connName}` : ''}`);
    else if (connectionState === 'error') setAlert('Connection failed');
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
