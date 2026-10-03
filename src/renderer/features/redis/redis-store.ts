import { TAIL_SYSTEM_CHANNEL, droppedFromNotice, pushCapped } from '@/features/live-tail/live-tail';
import { cleanIpcError } from '@/lib/errors';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import type { RedisAnalyzeResult, RedisCommandResult, RedisPubsubMessage } from '@shared/protocol';
import { create } from 'zustand';
import { globToRegExp } from './redis-format';

/**
 * Per-tab state for Redis tool tabs, kept outside the components so it
 * survives tab switches (R13/R18): the canvas only mounts the active tab.
 *
 *   - redis-cli     transcript + prompt db; history is global + persisted
 *   - redis-analyze last result + inputs
 *   - redis-pubsub  message buffer + subscription status. Subscriptions
 *                   live as long as the *tab*, not the component; closing
 *                   the tab unsubscribes.
 *
 * Everything is dropped when the connection changes.
 */

export interface CliEntry {
  id: string;
  /** Prompt as it read when the command was sent (`host:port[db]>`). */
  prompt: string;
  command: string;
  result: RedisCommandResult | null;
  error: string | null;
  /** Local note (refused / cancelled / needs edit mode) — never sent. */
  notice?: string | null;
  durationMs: number | null;
}

export interface CliTabState {
  entries: CliEntry[];
  db: number;
  busy: boolean;
}

export interface AnalyzeTabState {
  match: string;
  sampleCap: string;
  running: boolean;
  error: string | null;
  result: RedisAnalyzeResult | null;
  tookMs: number | null;
}

export type PubsubStatus = 'subscribing' | 'live' | 'error' | 'stopped';

export interface PubsubRow extends RedisPubsubMessage {
  seq: number;
}

export interface PubsubTabState {
  channel: string;
  pattern: boolean;
  messages: PubsubRow[];
  status: PubsubStatus;
  paused: boolean;
  error: string | null;
  seq: number;
  /** Text filter over channel + message (see live-tail matchesTailFilter). */
  filter: string;
  /** Messages lost to the worker's flood control or to the buffer cap. */
  dropped: number;
}

export const PUBSUB_MAX_MESSAGES = 2000;
const HISTORY_KEY = 'plasma.redis.cliHistory';
const HISTORY_MAX = 500;

function readHistory(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(HISTORY_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === 'string').slice(-HISTORY_MAX)
      : [];
  } catch {
    return [];
  }
}

function writeHistory(h: string[]): void {
  try {
    globalThis.localStorage?.setItem(HISTORY_KEY, JSON.stringify(h.slice(-HISTORY_MAX)));
  } catch {
    /* storage unavailable */
  }
}

interface RedisTabsState {
  cli: Record<string, CliTabState>;
  history: string[];
  analyze: Record<string, AnalyzeTabState>;
  pubsub: Record<string, PubsubTabState>;
  updateCli(tabId: string, fn: (s: CliTabState) => Partial<CliTabState>): void;
  pushHistory(cmd: string): void;
  updateAnalyze(tabId: string, patch: Partial<AnalyzeTabState>): void;
  pubsubStart(tabId: string, channel: string, pattern: boolean): Promise<void>;
  pubsubStop(tabId: string): Promise<void>;
  pubsubPatch(tabId: string, patch: Partial<PubsubTabState>): void;
  reset(): void;
}

export const DEFAULT_ANALYZE: AnalyzeTabState = {
  match: '',
  sampleCap: '5000',
  running: false,
  error: null,
  result: null,
  tookMs: null,
};

export const useRedisTabs = create<RedisTabsState>((set, get) => ({
  cli: {},
  history: readHistory(),
  analyze: {},
  pubsub: {},

  updateCli(tabId, fn) {
    set((s) => {
      const cur = s.cli[tabId] ?? {
        entries: [],
        db: useSession.getState().redisDb ?? 0,
        busy: false,
      };
      return { cli: { ...s.cli, [tabId]: { ...cur, ...fn(cur) } } };
    });
  },

  pushHistory(cmd) {
    const h = get().history;
    const next = h[h.length - 1] === cmd ? h : [...h, cmd].slice(-HISTORY_MAX);
    writeHistory(next);
    set({ history: next });
  },

  updateAnalyze(tabId, patch) {
    set((s) => ({
      analyze: { ...s.analyze, [tabId]: { ...(s.analyze[tabId] ?? DEFAULT_ANALYZE), ...patch } },
    }));
  },

  async pubsubStart(tabId, channel, pattern) {
    ensurePubsubListener();
    const prev = get().pubsub[tabId];
    if (prev && (prev.status === 'live' || prev.status === 'subscribing')) return;
    set((s) => ({
      pubsub: {
        ...s.pubsub,
        [tabId]: {
          channel,
          pattern,
          messages: prev?.messages ?? [],
          seq: prev?.seq ?? 0,
          filter: prev?.filter ?? '',
          dropped: prev?.dropped ?? 0,
          paused: false,
          status: 'subscribing',
          error: null,
        },
      },
    }));
    try {
      await ipc.redis.subscribe(channel, pattern);
      if (get().pubsub[tabId]) get().pubsubPatch(tabId, { status: 'live' });
      else void ipc.redis.unsubscribe(channel, pattern).catch(() => {});
    } catch (err) {
      get().pubsubPatch(tabId, {
        status: 'error',
        error: cleanIpcError(err instanceof Error ? err.message : String(err)),
      });
    }
  },

  async pubsubStop(tabId) {
    const cur = get().pubsub[tabId];
    if (!cur) return;
    const wasOn = cur.status === 'live' || cur.status === 'subscribing';
    get().pubsubPatch(tabId, { status: 'stopped', paused: false });
    if (wasOn) await ipc.redis.unsubscribe(cur.channel, cur.pattern).catch(() => {});
  },

  pubsubPatch(tabId, patch) {
    set((s) => {
      const cur = s.pubsub[tabId];
      if (!cur) return s;
      return { pubsub: { ...s.pubsub, [tabId]: { ...cur, ...patch } } };
    });
  },

  reset() {
    set({ cli: {}, analyze: {}, pubsub: {} });
  },
}));

// ── Pub/sub fan-out: one IPC listener feeding every live tab ──

let listenerInstalled = false;
const regexCache = new Map<string, RegExp>();

export function matchesSubscription(channel: string, pattern: boolean, incoming: string): boolean {
  if (!pattern) return incoming === channel;
  let re = regexCache.get(channel);
  if (!re) {
    re = globToRegExp(channel);
    regexCache.set(channel, re);
  }
  return re.test(incoming);
}

function ensurePubsubListener(): void {
  if (listenerInstalled || typeof window === 'undefined' || !window.plasmaEvents) return;
  listenerInstalled = true;
  window.plasmaEvents.on('plasma:redis:pubsub', (payload: unknown) => {
    const msg = payload as RedisPubsubMessage;
    const state = useRedisTabs.getState();
    let changed = false;
    const next: Record<string, PubsubTabState> = { ...state.pubsub };
    for (const [tabId, t] of Object.entries(state.pubsub)) {
      if (t.status !== 'live' || t.paused) continue;
      // The worker's flood notice is not a channel message: every live tail shows it.
      const system = msg.channel === TAIL_SYSTEM_CHANNEL;
      if (!system && t.pattern !== msg.pattern) continue;
      if (!system && !matchesSubscription(t.channel, t.pattern, msg.channel)) continue;
      const seq = t.seq + 1;
      const { rows: messages, dropped } = pushCapped(
        t.messages,
        { ...msg, seq },
        PUBSUB_MAX_MESSAGES,
      );
      next[tabId] = {
        ...t,
        seq,
        messages,
        dropped: t.dropped + dropped + droppedFromNotice(msg.channel, msg.message),
      };
      changed = true;
    }
    if (changed) useRedisTabs.setState({ pubsub: next });
  });
}

// ── Lifecycle: follow tabs and connections ──

let lastConnId: string | null | undefined;
let lastGen: number | undefined;
useSession.subscribe((s) => {
  const connId = s.activeConfig?.id ?? null;
  const gen = s.connectionGen as number;
  const store = useRedisTabs.getState();
  if (lastConnId !== undefined && connId !== lastConnId) {
    // Different server: nothing from the old one applies.
    store.reset();
  } else if (lastGen !== undefined && gen !== lastGen) {
    // Same server, new session: the worker lost the subscriptions.
    for (const [tabId, t] of Object.entries(store.pubsub)) {
      if (t.status === 'live' || t.status === 'subscribing') {
        store.pubsubPatch(tabId, {
          status: 'stopped',
          error: 'Connection was re-established — subscribe again.',
        });
      }
    }
  }
  lastConnId = connId;
  lastGen = gen;

  // Closed tabs: unsubscribe and forget their state.
  const open = new Set(s.tabs.map((t: { id: string }) => t.id));
  for (const tabId of Object.keys(store.pubsub)) {
    if (!open.has(tabId)) {
      void store.pubsubStop(tabId).then(() => {
        useRedisTabs.setState((st) => {
          const { [tabId]: _gone, ...rest } = st.pubsub;
          return { pubsub: rest };
        });
      });
    }
  }
  for (const key of ['cli', 'analyze'] as const) {
    const rec = useRedisTabs.getState()[key];
    if (Object.keys(rec).some((id) => !open.has(id))) {
      const kept = Object.fromEntries(Object.entries(rec).filter(([id]) => open.has(id)));
      useRedisTabs.setState({ [key]: kept } as Partial<RedisTabsState>);
    }
  }
});
