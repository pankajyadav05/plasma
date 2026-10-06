import type { UpdateStatus } from '@shared/protocol';
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';

/**
 * When the last check ended. Shared by every `useUpdate()` caller: Settings mounts
 * its own hook long after the check the top bar saw.
 */
export const useLastChecked = create<{ at: number | null; stamp(at: number): void }>((set) => ({
  at: null,
  stamp: (at) => set({ at }),
}));

/**
 * Subscribe to auto-update status. Combines initial fetch (`status()`)
 * + live event stream (`plasma:update:status`) so the UI is correct
 * the moment it mounts and stays correct as the updater progresses.
 *
 * Returns the latest status, when the last check finished, and thin wrappers
 * around the IPC actions.
 */
export function useUpdate() {
  const [status, setStatus] = useState<UpdateStatus>({ kind: 'idle' });
  const lastCheckedAt = useLastChecked((s) => s.at);
  const setLastCheckedAt = useLastChecked((s) => s.stamp);
  const prevKind = useRef<UpdateStatus['kind']>('idle');

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

  useEffect(() => {
    // A check just ended (whatever it found), or main stamped the answer itself.
    if (status.kind === 'not-available' && status.checkedAt) setLastCheckedAt(status.checkedAt);
    else if (prevKind.current === 'checking' && status.kind !== 'checking') {
      setLastCheckedAt(Date.now());
    }
    prevKind.current = status.kind;
  }, [status, setLastCheckedAt]);

  return {
    status,
    lastCheckedAt,
    check: () => window.plasma.update.check(),
    install: () => window.plasma.update.install(),
  };
}
