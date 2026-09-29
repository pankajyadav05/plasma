import { create } from 'zustand';
import { useSession } from './session';

/**
 * Auto-connect / auto-reconnect state machine.
 *
 *   idle ──start()──▶ waiting ──timer / online / click──▶ connecting
 *                        ▲                                   │
 *                        └──── failed attempt, retries left ─┤
 *                                                            ├─ connected ─▶ idle
 *                        failed ◀── no retries left / auto off
 *
 * Main already retries a dropped session once, transparently (U27). This
 * covers what it can't: that retry failing, the worker crashing, or the
 * database being unreachable at launch. The target is remembered so the
 * status capsule can always offer a one-click reconnect.
 */

/** Delay before each automatic attempt; the list length caps the retries. */
export const RECONNECT_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000, 30_000, 60_000];

export interface ReconnectTarget {
  id: string;
  name: string;
}

export type ReconnectPhase = 'idle' | 'waiting' | 'connecting' | 'failed';
export type ReconnectReason = 'launch' | 'lost' | 'manual';

interface ReconnectState {
  target: ReconnectTarget | null;
  reason: ReconnectReason | null;
  phase: ReconnectPhase;
  /** Automatic attempts made so far for this target. */
  attempt: number;
  /** Epoch ms of the next scheduled attempt while `waiting`. */
  nextAt: number | null;
  lastError: string | null;
  /**
   * Begin (re)connecting to `target`. `launch` and `manual` try right
   * away; `lost` waits the first backoff step so a flapping network
   * isn't hammered.
   */
  start(target: ReconnectTarget, reason: ReconnectReason): void;
  /** Attempt immediately (capsule click, network back online). */
  reconnectNow(): Promise<void>;
  /** Stop retrying and forget the target (explicit disconnect / other connection). */
  cancel(): void;
}

let timer: ReturnType<typeof setTimeout> | null = null;

function clearTimer() {
  if (timer) clearTimeout(timer);
  timer = null;
}

export const useReconnect = create<ReconnectState>((set, get) => {
  const schedule = () => {
    const { attempt } = get();
    const autoOn = useSession.getState().settings.autoReconnect;
    // Buffered grid edits need a human decision before a new session
    // exists (the connect gate asks) — never auto-connect over them.
    const blocked = useSession.getState().pendingEdits.length > 0;
    if (!autoOn || blocked || attempt >= RECONNECT_DELAYS_MS.length) {
      clearTimer();
      set({
        phase: 'failed',
        nextAt: null,
        lastError:
          blocked && !get().lastError
            ? 'Unsaved edits are pending — reconnect manually'
            : get().lastError,
      });
      return;
    }
    const delay = RECONNECT_DELAYS_MS[attempt] ?? RECONNECT_DELAYS_MS[RECONNECT_DELAYS_MS.length - 1];
    clearTimer();
    set({ phase: 'waiting', nextAt: Date.now() + delay });
    timer = setTimeout(() => void get().reconnectNow(), delay);
  };

  return {
    target: null,
    reason: null,
    phase: 'idle',
    attempt: 0,
    nextAt: null,
    lastError: null,

    start(target, reason) {
      clearTimer();
      set({ target, reason, attempt: 0, lastError: null, nextAt: null, phase: 'waiting' });
      if (reason === 'lost') schedule();
      else void get().reconnectNow();
    },

    async reconnectNow() {
      const { target, phase } = get();
      if (!target || phase === 'connecting') return;
      clearTimer();
      set({ phase: 'connecting', nextAt: null });

      await useSession.getState().connectSaved(target.id);

      // The target may have been cancelled while the attempt ran.
      if (get().target?.id !== target.id) return;
      const s = useSession.getState();
      if (s.connectionState === 'connected' && s.activeConfig?.id === target.id) {
        set({ phase: 'idle', target: null, reason: null, attempt: 0, lastError: null });
        return;
      }
      if (s.connectionActionGate) {
        // The pending-edits gate is now asking the user — stop here.
        set({ phase: 'failed', lastError: 'Unsaved edits are pending — reconnect manually' });
        return;
      }
      set({ attempt: get().attempt + 1, lastError: s.connectionError ?? 'Connection failed' });
      schedule();
    },

    cancel() {
      clearTimer();
      set({ target: null, reason: null, phase: 'idle', attempt: 0, nextAt: null, lastError: null });
    },
  };
});

// Any connection established outside this machine — the user picked
// another connection, or main recovered the session by itself — ends
// the retry loop.
useSession.subscribe((state, prev) => {
  if (state.connectionState !== 'connected' || prev.connectionState === 'connected') return;
  const r = useReconnect.getState();
  if (r.target && r.phase !== 'connecting') r.cancel();
});
