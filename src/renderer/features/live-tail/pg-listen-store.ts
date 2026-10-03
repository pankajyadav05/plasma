import { cleanIpcError } from '@/lib/errors';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import type { PgNotification } from '@shared/pg-listen';
import { create } from 'zustand';
import { TAIL_MAX_MESSAGES, droppedFromNotice, pushCapped } from './live-tail';

export interface PgTailRow extends PgNotification {
  seq: number;
}

export interface PgListenTabState {
  /** Channels with a live LISTEN on the dedicated connection. */
  channels: string[];
  messages: PgTailRow[];
  paused: boolean;
  filter: string;
  /** Messages lost to the worker's flood control or to the buffer cap. */
  dropped: number;
  seq: number;
  error: string | null;
  busy: boolean;
}

const EMPTY: PgListenTabState = {
  channels: [],
  messages: [],
  paused: false,
  filter: '',
  dropped: 0,
  seq: 0,
  error: null,
  busy: false,
};

interface PgListenStore {
  tabs: Record<string, PgListenTabState>;
  listen(tabId: string, channel: string): Promise<void>;
  unlisten(tabId: string, channel: string): Promise<void>;
  /** Stop everything for a tab (tab closed) and forget it. */
  release(tabId: string): Promise<void>;
  patch(tabId: string, patch: Partial<PgListenTabState>): void;
  clear(tabId: string): void;
  reset(): void;
}

const errText = (err: unknown) => cleanIpcError(err instanceof Error ? err.message : String(err));

export const usePgListen = create<PgListenStore>((set, get) => ({
  tabs: {},

  patch(tabId, patch) {
    set((s) => ({ tabs: { ...s.tabs, [tabId]: { ...(s.tabs[tabId] ?? EMPTY), ...patch } } }));
  },

  clear(tabId) {
    get().patch(tabId, { messages: [], dropped: 0 });
  },

  async listen(tabId, channel) {
    ensureListener();
    const name = channel.trim();
    if (!name) return;
    const cur = get().tabs[tabId] ?? EMPTY;
    if (cur.channels.includes(name)) return;
    get().patch(tabId, { busy: true, error: null });
    try {
      await ipc.pgListen.start(name);
      const now = get().tabs[tabId] ?? EMPTY;
      get().patch(tabId, { channels: [...now.channels, name], busy: false });
    } catch (err) {
      get().patch(tabId, { busy: false, error: errText(err) });
    }
  },

  async unlisten(tabId, channel) {
    const cur = get().tabs[tabId];
    if (!cur) return;
    get().patch(tabId, { channels: cur.channels.filter((c) => c !== channel) });
    // Another tab may still want it; the worker keeps one LISTEN per name.
    const stillWanted = Object.entries(get().tabs).some(
      ([id, t]) => id !== tabId && t.channels.includes(channel),
    );
    if (!stillWanted) await ipc.pgListen.stop(channel).catch(() => undefined);
  },

  async release(tabId) {
    const cur = get().tabs[tabId];
    if (!cur) return;
    set((s) => {
      const { [tabId]: _gone, ...rest } = s.tabs;
      return { tabs: rest };
    });
    for (const c of cur.channels) {
      const stillWanted = Object.values(get().tabs).some((t) => t.channels.includes(c));
      if (!stillWanted) await ipc.pgListen.stop(c).catch(() => undefined);
    }
  },

  reset() {
    set({ tabs: {} });
  },
}));

let installed = false;
function ensureListener(): void {
  if (installed || typeof window === 'undefined' || !window.plasmaEvents) return;
  installed = true;
  window.plasmaEvents.on('plasma:pg:notification', (payload: unknown) => {
    const n = payload as PgNotification;
    const { tabs } = usePgListen.getState();
    let changed = false;
    const next: Record<string, PgListenTabState> = { ...tabs };
    for (const [tabId, t] of Object.entries(tabs)) {
      if (t.channels.length === 0 || t.paused) continue;
      const system = n.channel === '(plasma)';
      if (!system && !t.channels.includes(n.channel)) continue;
      // The worker said its listener connection died: nothing is listened to any more.
      const lost = system && /connection was lost/.test(n.payload);
      const { rows, dropped } = pushCapped(
        t.messages,
        { ...n, seq: t.seq + 1 } as PgTailRow,
        TAIL_MAX_MESSAGES,
      );
      next[tabId] = {
        ...t,
        seq: t.seq + 1,
        messages: rows,
        dropped: t.dropped + dropped + droppedFromNotice(n.channel, n.payload),
        channels: lost ? [] : t.channels,
      };
      changed = true;
    }
    if (changed) usePgListen.setState({ tabs: next });
  });
}

// Follow tabs and connections: a closed tab or a new session leaves nothing listening.
let lastConnId: string | null | undefined;
let lastGen: number | undefined;
useSession.subscribe((s) => {
  const connId = s.activeConfig?.id ?? null;
  const gen = s.connectionGen as number;
  const store = usePgListen.getState();
  if (lastConnId !== undefined && connId !== lastConnId) {
    store.reset();
  } else if (lastGen !== undefined && gen !== lastGen) {
    // Same server, new session: the worker's listener went with the old one.
    for (const [tabId, t] of Object.entries(store.tabs)) {
      if (t.channels.length > 0) {
        store.patch(tabId, {
          channels: [],
          error: 'Connection was re-established — start listening again.',
        });
      }
    }
  }
  lastConnId = connId;
  lastGen = gen;

  const open = new Set(s.tabs.map((t: { id: string }) => t.id));
  for (const tabId of Object.keys(store.tabs)) {
    if (!open.has(tabId)) void store.release(tabId);
  }
});
