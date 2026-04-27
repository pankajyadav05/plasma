import type { UpdateStatus } from '@shared/protocol';
import { useEffect, useState } from 'react';

/**
 * Subscribe to auto-update status. Combines initial fetch (`status()`)
 * + live event stream (`plasma:update:status`) so the UI is correct
 * the moment it mounts and stays correct as the updater progresses.
 *
 * Returns the latest status plus thin wrappers around the IPC actions.
 */
export function useUpdate() {
  const [status, setStatus] = useState<UpdateStatus>({ kind: 'idle' });

  useEffect(() => {
    let cancelled = false;
    void window.plasma.update.status().then((s) => {
      if (!cancelled) setStatus(s);
    });
    const off = window.plasmaEvents.on('plasma:update:status', (next) => {
      setStatus(next as UpdateStatus);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return {
    status,
    check: () => window.plasma.update.check(),
    install: () => window.plasma.update.install(),
  };
}
