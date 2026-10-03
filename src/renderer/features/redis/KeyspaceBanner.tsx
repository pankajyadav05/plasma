import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Pill } from '@/components/ui/workbench';
import { cleanIpcError } from '@/lib/errors';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import {
  NOTIFY_CONFIG_KEY,
  flagsWithKeyevents,
  keyeventsEnabled,
  parseNotifyConfigReply,
} from '@shared/redis-keyspace';
import { useCallback, useEffect, useState } from 'react';

type State =
  | { kind: 'loading' }
  | { kind: 'on'; flags: string }
  | { kind: 'off'; flags: string }
  | { kind: 'unknown'; reason: string };

/**
 * Above a keyspace-events tail: says whether the server publishes key events
 * (`notify-keyspace-events`) and offers to turn them on. The change is a
 * `CONFIG SET`, so it is confirmed first and refused on read-only connections.
 */
export function KeyspaceBanner({ onEnabled }: { onEnabled?: () => void }) {
  const readOnly = useSession((s) => s.activeConfig?.readOnly === true);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    try {
      const res = await ipc.redis.command(['CONFIG', 'GET', NOTIFY_CONFIG_KEY]);
      const flags = parseNotifyConfigReply(res.reply);
      if (flags === null) {
        setState({ kind: 'unknown', reason: 'The server did not report the setting.' });
      } else {
        setState(keyeventsEnabled(flags) ? { kind: 'on', flags } : { kind: 'off', flags });
      }
    } catch (err) {
      setState({
        kind: 'unknown',
        reason: cleanIpcError(err instanceof Error ? err.message : String(err)),
      });
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  if (state.kind === 'loading' || state.kind === 'on') return null;

  const next = state.kind === 'off' ? flagsWithKeyevents(state.flags) : 'EA';
  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      await ipc.redis.command(['CONFIG', 'SET', NOTIFY_CONFIG_KEY, next]);
      await check();
      onEnabled?.();
    } catch (err) {
      setError(cleanIpcError(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <output
      className="flex shrink-0 items-center gap-3 border-b border-[var(--wb-separator)] bg-[color-mix(in_srgb,var(--status-staging)_14%,var(--wb-content))] px-3 py-1.5 text-[13px] text-[var(--wb-text)]"
      data-testid="keyspace-banner"
    >
      <span className="min-w-0 flex-1">
        {state.kind === 'off' ? (
          <>
            Keyspace notifications are off (<span className="font-mono">{NOTIFY_CONFIG_KEY}</span> ={' '}
            <span className="font-mono">"{state.flags}"</span>), so this tail stays empty.
          </>
        ) : (
          <>
            Could not read {NOTIFY_CONFIG_KEY}: {state.reason}
          </>
        )}
        {error && <span className="ml-2 text-destructive">{error}</span>}
        {readOnly && (
          <span className="ml-2 text-[var(--wb-text-2)]">
            This connection is read-only, so Plasma cannot turn them on.
          </span>
        )}
      </span>
      <Pill onClick={() => setConfirm(true)} disabled={busy || readOnly}>
        {busy ? 'Enabling…' : 'Enable'}
      </Pill>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Enable keyspace notifications?"
        variant="primary"
        confirmLabel="Run CONFIG SET"
        description={
          <>
            This runs{' '}
            <span className="font-mono">
              CONFIG SET {NOTIFY_CONFIG_KEY} {next}
            </span>{' '}
            on the server. It changes the live configuration for every client until the server
            restarts (it is not written to redis.conf), and costs some CPU on busy servers.
          </>
        }
        onConfirm={() => void enable()}
      />
    </output>
  );
}
