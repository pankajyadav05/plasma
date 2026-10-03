import { create } from 'zustand';

/** How long a revealed cell stays readable before it masks itself again. */
export const REVEAL_MS = 10_000;

/** Key of one cell of one result: `tab:row:column` (row = index in the result's rows). */
export function revealKey(tabId: string, rowIndex: number, col: number): string {
  return `${tabId}:${rowIndex}:${col}`;
}

interface RevealState {
  /** Cell key → epoch ms at which it masks again. */
  revealed: Record<string, number>;
  reveal(key: string, ms?: number): void;
  hide(key: string): void;
  clear(): void;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Click-to-reveal for masked cells. Every reveal expires on its own; turning
 * presentation mode off or on, or leaving the app, clears them all.
 */
export const useReveal = create<RevealState>((set, get) => ({
  revealed: {},

  reveal(key, ms = REVEAL_MS) {
    const prev = timers.get(key);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => get().hide(key), ms);
    // Never keep a node process (tests) or a closing window waiting on a mask timer.
    (t as { unref?: () => void }).unref?.();
    timers.set(key, t);
    set((s) => ({ revealed: { ...s.revealed, [key]: Date.now() + ms } }));
  },

  hide(key) {
    const t = timers.get(key);
    if (t) clearTimeout(t);
    timers.delete(key);
    set((s) => {
      if (!(key in s.revealed)) return s;
      const { [key]: _gone, ...rest } = s.revealed;
      return { revealed: rest };
    });
  },

  clear() {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    set({ revealed: {} });
  },
}));

export function isRevealed(revealed: Record<string, number>, key: string): boolean {
  return (revealed[key] ?? 0) > Date.now();
}
