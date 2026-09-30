/**
 * Redis slice of the session store — actions for the sidebar key browser,
 * db switcher, key/tool tabs, bulk + pattern deletes. Composed into
 * SessionState by session.ts (`...createRedisActions(set, get, …)`).
 *
 * Errors are never swallowed (R7): read actions store them in
 * `redisError` for the sidebar; write actions reject so the calling view
 * can show them next to the control the user used.
 */
import { ipc } from '@/lib/ipc';
import type {
  ConnectionConfig,
  RedisBulkDeleteResult,
  RedisKeyMeta,
  RedisOverview,
  RedisScanResult,
} from '@shared/protocol';
import { createEmptyTab } from './session-tab-model';
import type { SliceCreator } from './session-types';

// biome-ignore lint/suspicious/noExplicitAny: slice composed into SessionState (avoids an import cycle)
type SetFn = (partial: any, ...args: any[]) => void;
// biome-ignore lint/suspicious/noExplicitAny: slice composed into SessionState
type Get = () => any;
// biome-ignore lint/suspicious/noExplicitAny: QueryTab lives in session.ts
type Tab = any;

/** Keys requested per sidebar page. */
export const REDIS_SCAN_COUNT = 500;
/** A MATCH scan loops server-side until this many keys matched (R8/F10). */
export const REDIS_SCAN_MIN_RESULTS = 200;

export const REDIS_TAB_KINDS = new Set([
  'redis-key',
  'redis-cli',
  'redis-pubsub',
  'redis-analyze',
  'redis-slowlog',
  'redis-server',
]);

export function parseRedisDb(raw: string | undefined | null): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** State patch applied on every (re)connect: nothing from the previous server survives (R2/R6). */
export function redisConnectReset(config: Pick<ConnectionConfig, 'database' | 'engine'>) {
  return {
    editMode: false,
    redisBulkMode: false,
    selectedRedisKeys: new Set<string>(),
    redisDb: config.engine === 'redis' ? parseRedisDb(config.database) : 0,
    redisError: null,
    redisTypeFilter: null,
    redisScanning: false,
  };
}

export const REDIS_INITIAL_STATE = {
  redisDb: 0,
  redisError: null as string | null,
  redisTypeFilter: null as string | null,
  /** True while a scan page is in flight (the sidebar shows "Searching…"). */
  redisScanning: false,
};

/** Append a SCAN page to the loaded keys, dropping duplicates SCAN may return. */
export function mergeScanPages(
  prev: RedisScanResult | null,
  page: RedisScanResult,
): RedisScanResult {
  if (!prev) return dedupe(page);
  const seen = new Set(prev.keys.map((k) => k.key));
  const fresh = page.keys.filter((k) => {
    if (seen.has(k.key)) return false;
    seen.add(k.key);
    return true;
  });
  return {
    cursor: page.cursor,
    keys: [...prev.keys, ...fresh],
    scanned: prev.scanned + fresh.length,
    iterations: (prev.iterations ?? 0) + (page.iterations ?? 0),
    db: page.db,
  };
}

function dedupe(page: RedisScanResult): RedisScanResult {
  const seen = new Set<string>();
  const keys = page.keys.filter((k) => {
    if (seen.has(k.key)) return false;
    seen.add(k.key);
    return true;
  });
  return { ...page, keys, scanned: keys.length };
}

function errText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

let scanSeq = 0;

export function createRedisActions(
  set: SetFn,
  get: Get,
  createEmptyTab: (pageSize: number, title?: string) => Tab,
) {
  const dropKeys = (keys: Iterable<string>, db: number) => {
    const dropped = new Set(keys);
    set((state: ReturnType<Get>) => ({
      redisKeys:
        state.redisKeys && state.redisDb === db
          ? {
              ...state.redisKeys,
              keys: state.redisKeys.keys.filter((k: RedisKeyMeta) => !dropped.has(k.key)),
            }
          : state.redisKeys,
      tabs: state.tabs.filter(
        (t: Tab) =>
          !(
            t.kind === 'redis-key' &&
            dropped.has(t.redisKey) &&
            (t.redisDb ?? state.redisDb) === db
          ),
      ),
      activeRedisKey:
        state.activeRedisKey && dropped.has(state.activeRedisKey) ? null : state.activeRedisKey,
    }));
    // Closing the active tab may leave activeTabId dangling.
    const s = get();
    if (!s.tabs.some((t: Tab) => t.id === s.activeTabId) && s.tabs.length > 0) {
      set({ activeTabId: s.tabs[s.tabs.length - 1].id });
    }
  };

  const openSingleton = (kind: string, title: string) => {
    const state = get();
    const existing = state.tabs.find((t: Tab) => t.kind === kind);
    if (existing) {
      set({ activeTabId: existing.id });
      return;
    }
    const tab = { ...createEmptyTab(state.settings.defaultPageSize, title), kind };
    set({ tabs: [...state.tabs, tab], activeTabId: tab.id });
  };

  return {
    async refreshRedisOverview() {
      set({ redisLoading: true });
      try {
        const info = await ipc.redis.overview();
        set({ redisOverview: info, redisOverviewAt: Date.now() });
      } catch (err) {
        set({ redisError: `Server info: ${errText(err)}` });
      } finally {
        set({ redisLoading: false });
      }
    },

    async scanRedisKeys(opts?: { cursor?: string; match?: string }) {
      const state = get();
      const cursor = opts?.cursor ?? '0';
      // Continuations always use the pattern the cursor belongs to (R8).
      const match = opts?.match !== undefined ? opts.match : (state.redisMatch ?? undefined);
      const db: number = state.redisDb ?? 0;
      const seq = ++scanSeq;
      set({ redisLoading: true, redisScanning: true, redisError: null });
      try {
        const page = await ipc.redis.scan({
          cursor,
          match: match || undefined,
          count: REDIS_SCAN_COUNT,
          db,
          minResults: REDIS_SCAN_MIN_RESULTS,
          budgetMs: 1500,
          type: state.redisTypeFilter ?? undefined,
        });
        if (seq !== scanSeq || get().redisDb !== db) return; // superseded
        set({
          redisKeys:
            cursor === '0' ? mergeScanPages(null, page) : mergeScanPages(get().redisKeys, page),
        });
      } catch (err) {
        if (seq === scanSeq) set({ redisError: errText(err) });
      } finally {
        if (seq === scanSeq) set({ redisLoading: false, redisScanning: false });
      }
    },

    setRedisMatch(match: string | null) {
      set({ redisMatch: match, redisKeys: null, selectedRedisKeys: new Set() });
      void get().scanRedisKeys({ cursor: '0', match: match ?? '' });
    },

    setRedisTypeFilter(type: string | null) {
      set({ redisTypeFilter: type, redisKeys: null, selectedRedisKeys: new Set() });
      void get().scanRedisKeys({ cursor: '0' });
    },

    /** R20: switch the sidebar (and new key tabs / CLI prompt default) to another db. */
    setRedisDb(db: number) {
      if (!Number.isInteger(db) || db < 0) return;
      set({
        redisDb: db,
        redisKeys: null,
        selectedRedisKeys: new Set(),
        redisBulkMode: false,
        activeRedisKey: null,
      });
      void get().scanRedisKeys({ cursor: '0' });
    },

    openRedisKey(key: string, db?: number) {
      const state = get();
      const targetDb: number = db ?? state.redisDb ?? 0;
      const existing = state.tabs.find(
        (t: Tab) => t.kind === 'redis-key' && t.redisKey === key && (t.redisDb ?? 0) === targetDb,
      );
      if (existing) {
        set({ activeTabId: existing.id, activeRedisKey: key });
        return;
      }
      const tab = {
        ...createEmptyTab(state.settings.defaultPageSize, key),
        kind: 'redis-key',
        redisKey: key,
        redisDb: targetDb,
      };
      set({ tabs: [...state.tabs, tab], activeTabId: tab.id, activeRedisKey: key });
    },

    openRedisCli() {
      openSingleton('redis-cli', 'redis-cli');
    },

    /** Reuses an open tab on the same channel/pattern instead of stacking duplicates. */
    openRedisPubsub(channel: string, pattern: boolean) {
      const state = get();
      const existing = state.tabs.find(
        (t: Tab) =>
          t.kind === 'redis-pubsub' && t.redisChannel === channel && t.redisPattern === pattern,
      );
      if (existing) {
        set({ activeTabId: existing.id });
        return;
      }
      const tab = {
        ...createEmptyTab(
          state.settings.defaultPageSize,
          pattern ? `psub · ${channel}` : `sub · ${channel}`,
        ),
        kind: 'redis-pubsub',
        redisChannel: channel,
        redisPattern: pattern,
      };
      set({ tabs: [...state.tabs, tab], activeTabId: tab.id });
    },

    openRedisAnalyze() {
      openSingleton('redis-analyze', 'memory analyzer');
    },

    openRedisSlowlog() {
      openSingleton('redis-slowlog', 'slowlog');
    },

    openRedisServer() {
      openSingleton('redis-server', 'server');
    },

    toggleRedisBulkMode() {
      const state = get();
      set({
        redisBulkMode: !state.redisBulkMode,
        selectedRedisKeys: state.redisBulkMode ? new Set() : state.selectedRedisKeys,
      });
    },

    toggleRedisKeyChecked(key: string) {
      const next = new Set<string>(get().selectedRedisKeys);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      set({ selectedRedisKeys: next });
    },

    clearRedisSelected() {
      set({ selectedRedisKeys: new Set() });
    },

    /**
     * R1/R7: resolves with the per-key result. Only keys actually deleted
     * leave the sidebar; failed keys stay selected so the user can retry.
     */
    async bulkDeleteSelectedRedisKeys(): Promise<RedisBulkDeleteResult> {
      const keys = [...(get().selectedRedisKeys as Set<string>)];
      if (keys.length === 0) return { deleted: [], failed: [] };
      const db: number = get().redisDb ?? 0;
      const result = await ipc.redis.bulkDelete(keys, { db });
      dropKeys(result.deleted, db);
      const failed = new Set(result.failed.map((f) => f.key));
      set({
        selectedRedisKeys: failed,
        redisBulkMode: failed.size > 0,
      });
      void get().refreshRedisOverview();
      return result;
    },

    /** Rejects on failure (R7) — the caller shows the error. */
    async deleteRedisKey(key: string, db?: number) {
      const target: number = db ?? get().redisDb ?? 0;
      await ipc.redis.deleteKey(key, { db: target });
      dropKeys([key], target);
      void get().refreshRedisOverview();
    },

    /** Rejects on failure (R7). */
    async setRedisTtl(
      key: string,
      seconds: number,
      opts?: { db?: number; mode?: 'expire' | 'pexpire' | 'expireat' | 'persist' },
    ) {
      await ipc.redis.setTtl(key, seconds, {
        db: opts?.db ?? get().redisDb ?? 0,
        mode: opts?.mode,
      });
    },

    /** After a pattern delete: forget whatever the sidebar still shows for it. */
    redisKeysRemoved(keys: string[], db: number) {
      dropKeys(keys, db);
    },

    /** After create / copy: show the new key without rescanning (keeps paging). */
    redisKeyAdded(meta: RedisKeyMeta, db: number) {
      const state = get();
      if (state.redisDb !== db || !state.redisKeys) return;
      if (state.redisKeys.keys.some((k: RedisKeyMeta) => k.key === meta.key)) return;
      set({ redisKeys: { ...state.redisKeys, keys: [meta, ...state.redisKeys.keys] } });
      void get().refreshRedisOverview();
    },

    /** After RENAME: rename in the sidebar list and retarget open key tabs. */
    redisKeyRenamed(from: string, to: string, db: number) {
      set((state: ReturnType<Get>) => ({
        redisKeys:
          state.redisKeys && state.redisDb === db
            ? {
                ...state.redisKeys,
                keys: state.redisKeys.keys
                  .filter((k: RedisKeyMeta) => k.key !== to)
                  .map((k: RedisKeyMeta) => (k.key === from ? { ...k, key: to } : k)),
              }
            : state.redisKeys,
        tabs: state.tabs.map((t: Tab) =>
          t.kind === 'redis-key' && t.redisKey === from && (t.redisDb ?? 0) === db
            ? { ...t, redisKey: to, title: to }
            : t,
        ),
        activeRedisKey: state.activeRedisKey === from ? to : state.activeRedisKey,
      }));
    },
  };
}

// ─── Slice ───────────────────────────────────────────────────────────

export interface RedisSlice {
  // ── non-relational engine state ──
  /** Latest INFO snapshot for a connected Redis instance. */
  redisOverview: RedisOverview | null;
  /** Cached SCAN page used by the Redis sidebar key tree. */
  redisKeys: RedisScanResult | null;
  /** SCAN MATCH filter typed by the user; null = no filter. */
  redisMatch: string | null;
  redisLoading: boolean;
  /** Database the Redis sidebar browses (R20). */
  redisDb: number;
  /** Last Redis read error (scan / overview), shown in the sidebar (R7). */
  redisError: string | null;
  /** SCAN TYPE filter; null = all types (R30). */
  redisTypeFilter: string | null;
  /** A scan page is in flight. */
  redisScanning: boolean;
  /** Last-opened resource per non-relational engine, used to highlight sidebar. */
  activeRedisKey: string | null;
  // ── Bulk-select (Redis sidebar) ──
  /** When true, the Redis sidebar shows checkboxes next to each key. */
  redisBulkMode: boolean;
  /** Keys currently checked in bulk mode. Cleared on disconnect / mode-off. */
  selectedRedisKeys: Set<string>;
  // ── Non-relational engine actions ──
  refreshRedisOverview(): Promise<void>;
  scanRedisKeys(opts?: { cursor?: string; match?: string }): Promise<void>;
  setRedisMatch(match: string | null): void;
  setRedisTypeFilter(type: string | null): void;
  setRedisDb(db: number): void;
  openRedisKey(key: string, db?: number): void;
  openRedisCli(): void;
  openRedisPubsub(channel: string, pattern: boolean): void;
  openRedisAnalyze(): void;
  openRedisSlowlog(): void;
  openRedisServer(): void;
  /** Rejects on failure (R7). */
  deleteRedisKey(key: string, db?: number): Promise<void>;
  /** Rejects on failure (R7). */
  setRedisTtl(
    key: string,
    seconds: number,
    opts?: { db?: number; mode?: 'expire' | 'pexpire' | 'expireat' | 'persist' },
  ): Promise<void>;
  redisKeysRemoved(keys: string[], db: number): void;
  redisKeyAdded(meta: RedisKeyMeta, db: number): void;
  redisKeyRenamed(from: string, to: string, db: number): void;

  // Bulk select
  toggleRedisBulkMode(): void;
  toggleRedisKeyChecked(key: string): void;
  clearRedisSelected(): void;
  /** Resolves with the per-key result; rejects when the request failed (R1/R7). */
  bulkDeleteSelectedRedisKeys(): Promise<RedisBulkDeleteResult>;
}

export const createRedisSlice: SliceCreator<RedisSlice> = (set, get) => ({
  redisOverview: null,
  redisKeys: null,
  redisMatch: null,
  redisLoading: false,
  ...REDIS_INITIAL_STATE,
  activeRedisKey: null,
  redisBulkMode: false,
  selectedRedisKeys: new Set<string>(),
  ...createRedisActions(set, get, createEmptyTab),
});
