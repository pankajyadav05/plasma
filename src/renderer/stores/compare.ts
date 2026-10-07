/**
 * Result Compare store (C2). One session per compare tab, kept outside the
 * session store so big result copies never travel through its subscribers
 * (tabs are persisted and serialised; compare sessions are not).
 */
import { ipc } from '@/lib/ipc';
import type { QueryResult } from '@shared/protocol';
import {
  CompareError,
  type CompareOptions,
  type CompareSource,
  DEFAULT_COMPARE_OPTIONS,
  type DiffKind,
  type DiffResult,
  type KeySuggestion,
  MAX_COMPARE_ROWS,
  type SavedCompareSide,
  type SavedComparison,
  compareResults,
  diffToTable,
  parseSavedComparison,
  suggestKeys,
} from '@shared/result-compare';
import { create } from 'zustand';
import { useSession } from './session';
import { createEmptyTab } from './session-tab-model';
import type { QueryTab } from './session-types';

export type SideLabel = 'a' | 'b';

export interface CompareSide {
  status: 'empty' | 'loading' | 'ready' | 'error';
  /** Where the rows came from. */
  origin: 'tab' | 'query' | null;
  /** Saved connection id; null = the active connection. */
  connectionId: string | null;
  connectionName: string;
  sql: string;
  /** Tab title when the result was taken from a tab. */
  tabTitle?: string;
  capturedAt: number | null;
  source: CompareSource | null;
  rowCount: number;
  truncated: boolean;
  error?: string;
  /** Run in flight since (for the elapsed timer). */
  startedAt?: number;
  /** Primary keys of the table behind the query, when known. */
  primaryKeys: string[][];
}

export interface CompareSession {
  tabId: string;
  a: CompareSide;
  b: CompareSide;
  options: CompareOptions;
  /** True once the user touched the key picker; stops auto-suggestion. */
  keysChosen: boolean;
  phase: 'idle' | 'comparing' | 'done' | 'error';
  progress: number;
  result: DiffResult | null;
  error: string | null;
  /** Row kinds shown in the grid. */
  show: DiffKind[];
  suggestions: KeySuggestion[];
  /** Sources the current `result` was computed from. */
  resultFor: { a: CompareSource; b: CompareSource } | null;
  savedId: string | null;
  exportNote: string | null;
}

export const DIFF_ONLY: DiffKind[] = ['added', 'removed', 'changed', 'duplicate'];

const emptySide = (): CompareSide => ({
  status: 'empty',
  origin: null,
  connectionId: null,
  connectionName: '',
  sql: '',
  capturedAt: null,
  source: null,
  rowCount: 0,
  truncated: false,
  primaryKeys: [],
});

export type SideSeed =
  | { kind: 'tab'; tabId: string }
  | { kind: 'query'; connectionId: string | null; sql: string; tabTitle?: string };

interface CompareState {
  sessions: Record<string, CompareSession>;
  /** Open a compare tab, optionally pre-filled. Returns the new tab id. */
  open(seedA?: SideSeed, seedB?: SideSeed, options?: Partial<CompareOptions>): string;
  /** Fill one side. */
  setSide(tabId: string, side: SideLabel, seed: SideSeed): void;
  /** Re-run a side that came from a query. */
  rerunSide(tabId: string, side: SideLabel): void;
  clearSide(tabId: string, side: SideLabel): void;
  swap(tabId: string): void;
  setOptions(tabId: string, patch: Partial<CompareOptions>, byUser?: boolean): void;
  setShow(tabId: string, show: DiffKind[]): void;
  /** Re-run both query sides, then compare again. */
  rerunAll(tabId: string): void;
  exportDiff(tabId: string, format: 'csv' | 'json'): Promise<void>;
  save(tabId: string, name: string): void;
  load(tabId: string, saved: SavedComparison): void;
  remove(savedId: string): void;
  close(tabId: string): void;
}

const runSeq = new Map<string, number>();
const diffSeq = new Map<string, number>();
const nextSeq = (m: Map<string, number>, k: string) => {
  const n = (m.get(k) ?? 0) + 1;
  m.set(k, n);
  return n;
};

function patchSession(tabId: string, fn: (s: CompareSession) => Partial<CompareSession>) {
  useCompare.setState((st) => {
    const cur = st.sessions[tabId];
    if (!cur) return st;
    return { sessions: { ...st.sessions, [tabId]: { ...cur, ...fn(cur) } } };
  });
}

function patchSide(tabId: string, side: SideLabel, patch: Partial<CompareSide>) {
  patchSession(tabId, (s) => ({ [side]: { ...s[side], ...patch } }) as Partial<CompareSession>);
}

function connectionNameOf(id: string | null): string {
  const st = useSession.getState();
  if (id === null || id === st.activeConfig?.id)
    return st.activeConfig?.name ?? 'Active connection';
  return st.savedConnections.find((c) => c.id === id)?.name ?? 'Unknown connection';
}

/** `FROM schema.table` of a statement that reads exactly one table, else null. */
export function singleTableOf(sql: string): { schema?: string; table: string } | null {
  const s = sql.replace(/--.*$/gm, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  if (/\bjoin\b|\bunion\b|\bwith\b|,\s*\(?\s*select\b/i.test(s)) return null;
  const froms = s.match(/\bfrom\b/gi) ?? [];
  if (froms.length !== 1) return null;
  const m =
    /\bfrom\s+((?:"[^"]+"|[\w$]+)(?:\s*\.\s*(?:"[^"]+"|[\w$]+))?)\s*(?:as\s+\w+|\w+)?\s*(?:where|order|group|limit|offset|having|fetch|window|$|;|\))/i.exec(
      s,
    );
  if (!m) return null;
  const unq = (x: string) => (x.startsWith('"') ? x.slice(1, -1).replace(/""/g, '"') : x);
  const parts = m[1]!.split('.').map((p) => unq(p.trim()));
  return parts.length === 2 ? { schema: parts[0], table: parts[1]! } : { table: parts[0]! };
}

/** Primary-key column sets of the table a query reads, from the loaded schema. */
function primaryKeysFor(sql: string, connectionId: string | null): string[][] {
  const st = useSession.getState();
  if (connectionId !== null && connectionId !== st.activeConfig?.id) return [];
  const target = singleTableOf(sql);
  if (!target || !st.schema) return [];
  const schema = target.schema ?? st.currentSchema ?? 'public';
  const cols = st.schema.columns.filter(
    (c: { schema: string; table: string; isPrimaryKey?: boolean }) =>
      c.schema === schema && c.table === target.table && c.isPrimaryKey,
  );
  return cols.length > 0 ? [cols.map((c: { name: string }) => c.name)] : [];
}

function sourceFromResult(r: QueryResult): CompareSource {
  return {
    columns: r.columns.map((c) => c.name),
    types: r.columns.map((c) => c.dataTypeName),
    rows: r.rows,
  };
}

function sideFromTab(tab: QueryTab): CompareSide | string {
  const r: QueryResult | null = tab.queryResult;
  if (!r || r.columns.length === 0) return 'That tab has no rows to compare. Run a query first.';
  const st = useSession.getState();
  const lifecycle = tab.queryLifecycle;
  const sql = r.sql ?? tab.queryErrorSql ?? tab.sql ?? '';
  return {
    status: 'ready',
    origin: 'tab',
    connectionId: st.activeConfig?.id ?? null,
    connectionName: st.activeConfig?.name ?? 'Active connection',
    sql,
    tabTitle: tab.title,
    capturedAt: lifecycle?.phase === 'succeeded' ? lifecycle.since : Date.now(),
    source: sourceFromResult(r),
    rowCount: r.rows.length,
    truncated: r.truncated === true,
    primaryKeys: primaryKeysFor(sql, st.activeConfig?.id ?? null),
  };
}

const READ_ONLY_HINT = 'Compare runs one read-only statement (SELECT, WITH, SHOW or EXPLAIN).';

function friendlyRunError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const clean = raw.replace(/^Error invoking remote method '[^']+':\s*(?:\w*Error:\s*)?/, '');
  if (/^rejected:/i.test(clean)) return `${clean.replace(/^rejected:\s*/i, '')}. ${READ_ONLY_HINT}`;
  return clean;
}

export const useCompare = create<CompareState>((set, get) => ({
  sessions: {},

  open(seedA, seedB, options) {
    const ss = useSession.getState();
    const tab: QueryTab = {
      ...createEmptyTab(ss.settings.defaultPageSize, 'Compare'),
      kind: 'result-compare',
    };
    const session: CompareSession = {
      tabId: tab.id,
      a: emptySide(),
      b: emptySide(),
      options: { ...DEFAULT_COMPARE_OPTIONS, ...options },
      keysChosen: (options?.keys?.length ?? 0) > 0,
      phase: 'idle',
      progress: 0,
      result: null,
      error: null,
      show: DIFF_ONLY,
      suggestions: [],
      resultFor: null,
      savedId: null,
      exportNote: null,
    };
    set((st) => ({ sessions: { ...st.sessions, [tab.id]: session } }));
    useSession.setState((s) => ({
      tabs: [...s.tabs, tab],
      activeTabId: tab.id,
      canvasMode: 'database',
    }));
    if (seedA) get().setSide(tab.id, 'a', seedA);
    if (seedB) get().setSide(tab.id, 'b', seedB);
    return tab.id;
  },

  setSide(tabId, side, seed) {
    if (!get().sessions[tabId]) return;
    const seq = nextSeq(runSeq, `${tabId}:${side}`);
    if (seed.kind === 'tab') {
      const tab = useSession.getState().tabs.find((t) => t.id === seed.tabId);
      const next = tab ? sideFromTab(tab) : 'That tab is closed.';
      if (typeof next === 'string') {
        patchSide(tabId, side, { ...emptySide(), status: 'error', error: next });
        return;
      }
      patchSide(tabId, side, next);
      afterSidesChanged(tabId);
      return;
    }
    const connectionName = connectionNameOf(seed.connectionId);
    patchSide(tabId, side, {
      ...emptySide(),
      status: 'loading',
      origin: 'query',
      connectionId: seed.connectionId,
      connectionName,
      sql: seed.sql,
      tabTitle: seed.tabTitle,
      startedAt: Date.now(),
      primaryKeys: primaryKeysFor(seed.sql, seed.connectionId),
    });
    void (async () => {
      try {
        const res = await ipc.compare.run({
          connectionId: seed.connectionId,
          sql: seed.sql,
          maxRows: MAX_COMPARE_ROWS,
        });
        if (runSeq.get(`${tabId}:${side}`) !== seq) return;
        if (res.columns.length === 0) {
          patchSide(tabId, side, {
            status: 'error',
            error: 'That statement returns no rows to compare.',
          });
          return;
        }
        patchSide(tabId, side, {
          status: 'ready',
          source: sourceFromResult(res),
          rowCount: res.rows.length,
          truncated: res.truncated === true,
          capturedAt: Date.now(),
          startedAt: undefined,
        });
        afterSidesChanged(tabId);
      } catch (err) {
        if (runSeq.get(`${tabId}:${side}`) !== seq) return;
        patchSide(tabId, side, {
          status: 'error',
          error: friendlyRunError(err),
          startedAt: undefined,
        });
      }
    })();
  },

  rerunSide(tabId, side) {
    const s = get().sessions[tabId]?.[side];
    if (!s || !s.sql) return;
    get().setSide(tabId, side, {
      kind: 'query',
      connectionId: s.connectionId,
      sql: s.sql,
      tabTitle: s.tabTitle,
    });
  },

  clearSide(tabId, side) {
    nextSeq(runSeq, `${tabId}:${side}`);
    patchSession(tabId, () => ({
      [side]: emptySide(),
      result: null,
      resultFor: null,
      phase: 'idle',
      error: null,
    }));
  },

  swap(tabId) {
    patchSession(tabId, (s) => ({ a: s.b, b: s.a }));
    runSeq.delete(`${tabId}:a`);
    runSeq.delete(`${tabId}:b`);
    afterSidesChanged(tabId, true);
  },

  setOptions(tabId, patch, byUser = true) {
    patchSession(tabId, (s) => ({
      options: { ...s.options, ...patch },
      keysChosen: s.keysChosen || (byUser && 'keys' in patch),
    }));
    scheduleCompare(tabId);
  },

  setShow(tabId, show) {
    patchSession(tabId, () => ({ show }));
  },

  rerunAll(tabId) {
    const s = get().sessions[tabId];
    if (!s) return;
    for (const side of ['a', 'b'] as const) {
      if (s[side].origin === 'query') get().rerunSide(tabId, side);
      else if (s[side].origin === 'tab' && s[side].sql) {
        // A tab result is a snapshot; re-running it means running its SQL again.
        get().setSide(tabId, side, {
          kind: 'query',
          connectionId: s[side].connectionId,
          sql: s[side].sql,
          tabTitle: s[side].tabTitle,
        });
      }
    }
  },

  async exportDiff(tabId, format) {
    const s = get().sessions[tabId];
    if (!s?.result || !s.resultFor) return;
    const table = diffToTable(s.result, s.resultFor.a, s.resultFor.b, new Set(s.show));
    patchSession(tabId, () => ({ exportNote: null }));
    try {
      const res = await ipc.export.save({
        format,
        defaultPath: 'comparison',
        columns: table.columns.map((name) => ({ name, dataTypeID: 25, dataTypeName: 'text' })),
        rows: table.rows,
      });
      patchSession(tabId, () => ({
        exportNote: res.ok
          ? `Exported ${res.rowCount.toLocaleString()} rows to ${res.filePath}`
          : null,
      }));
    } catch (err) {
      patchSession(tabId, () => ({ exportNote: `Export failed: ${friendlyRunError(err)}` }));
    }
  },

  save(tabId, name) {
    const s = get().sessions[tabId];
    if (!s) return;
    const side = (x: CompareSide): SavedCompareSide | null =>
      x.sql.trim()
        ? { connectionId: x.connectionId, connectionName: x.connectionName, sql: x.sql }
        : null;
    const a = side(s.a);
    const b = side(s.b);
    if (!a || !b) return;
    const id = s.savedId ?? crypto.randomUUID();
    const entry: SavedComparison = {
      id,
      name: name.trim() || 'Comparison',
      a,
      b,
      options: s.options,
      savedAt: Date.now(),
    };
    const list = savedList().filter((c) => c.id !== id);
    writeSaved([entry, ...list]);
    patchSession(tabId, () => ({ savedId: id }));
  },

  load(tabId, saved) {
    patchSession(tabId, () => ({
      options: saved.options,
      keysChosen: saved.options.keys.length > 0,
      savedId: saved.id,
      result: null,
      resultFor: null,
      phase: 'idle',
    }));
    for (const side of ['a', 'b'] as const) {
      const def = saved[side];
      // A connection that was deleted since: fall back to the active one, visibly.
      const known =
        def.connectionId === null ||
        def.connectionId === useSession.getState().activeConfig?.id ||
        useSession.getState().savedConnections.some((c) => c.id === def.connectionId);
      get().setSide(tabId, side, {
        kind: 'query',
        connectionId: known ? def.connectionId : null,
        sql: def.sql,
      });
    }
  },

  remove(savedId) {
    writeSaved(savedList().filter((c) => c.id !== savedId));
  },

  close(tabId) {
    runSeq.delete(`${tabId}:a`);
    runSeq.delete(`${tabId}:b`);
    diffSeq.delete(tabId);
    set((st) => {
      if (!st.sessions[tabId]) return st;
      const { [tabId]: _gone, ...rest } = st.sessions;
      return { sessions: rest };
    });
  },
}));

/** Optimistic: the list updates at once, the write follows (R-17). */
function writeSaved(list: SavedComparison[]) {
  useSession.setState((st) => ({ settings: { ...st.settings, savedComparisons: list } }));
  void useSession.getState().updateSettings({ savedComparisons: list });
}

/** The saved comparisons in settings, validated. */
export function savedList(): SavedComparison[] {
  const raw = useSession.getState().settings.savedComparisons;
  if (!Array.isArray(raw)) return [];
  return raw.map(parseSavedComparison).filter((c): c is SavedComparison => c !== null);
}

/** Auto-suggest keys once both sides are in, then compare. */
function afterSidesChanged(tabId: string, keepKeys = false) {
  const s = useCompare.getState().sessions[tabId];
  if (!s) return;
  if (s.a.status !== 'ready' || s.b.status !== 'ready' || !s.a.source || !s.b.source) {
    patchSession(tabId, () => ({ result: null, resultFor: null, phase: 'idle', suggestions: [] }));
    return;
  }
  const suggestions = suggestKeys(
    s.a.source,
    s.b.source,
    [...s.a.primaryKeys, ...s.b.primaryKeys],
    s.options.ignore,
  );
  const best = suggestions[0];
  const title =
    s.a.connectionName === s.b.connectionName
      ? `Compare · ${s.a.connectionName}`
      : `${s.a.connectionName} vs ${s.b.connectionName}`;
  useSession.setState((st) => ({
    tabs: st.tabs.map((t) => (t.id === tabId ? { ...t, title } : t)),
  }));
  patchSession(tabId, (cur) => ({
    suggestions,
    options:
      !cur.keysChosen && !keepKeys && best ? { ...cur.options, keys: best.keys } : cur.options,
  }));
  scheduleCompare(tabId);
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Debounced compare of the two sides with the current options. */
function scheduleCompare(tabId: string) {
  const prev = timers.get(tabId);
  if (prev) clearTimeout(prev);
  timers.set(
    tabId,
    setTimeout(() => {
      timers.delete(tabId);
      void runCompare(tabId);
    }, 120),
  );
}

async function runCompare(tabId: string) {
  const s = useCompare.getState().sessions[tabId];
  if (!s || s.a.status !== 'ready' || s.b.status !== 'ready' || !s.a.source || !s.b.source) return;
  const seq = nextSeq(diffSeq, tabId);
  const a = s.a.source;
  const b = s.b.source;
  patchSession(tabId, () => ({ phase: 'comparing', progress: 0, error: null }));
  try {
    const result = await compareResults(a, b, s.options, {
      onProgress: (done, total) => {
        if (diffSeq.get(tabId) === seq) {
          patchSession(tabId, () => ({ progress: total === 0 ? 1 : done / total }));
        }
      },
      isCancelled: () => diffSeq.get(tabId) !== seq,
    });
    if (diffSeq.get(tabId) !== seq) return;
    patchSession(tabId, () => ({ phase: 'done', result, resultFor: { a, b }, progress: 1 }));
  } catch (err) {
    if (err instanceof CompareError && err.code === 'cancelled') return;
    if (diffSeq.get(tabId) !== seq) return;
    patchSession(tabId, () => ({
      phase: 'error',
      error: err instanceof Error ? err.message : String(err),
      result: null,
      resultFor: null,
    }));
  }
}

// A closed compare tab frees its rows.
useSession.subscribe((state, prev) => {
  if (state.tabs === prev.tabs) return;
  const sessions = useCompare.getState().sessions;
  const ids = Object.keys(sessions);
  if (ids.length === 0) return;
  const open = new Set(state.tabs.map((t) => t.id));
  for (const id of ids) if (!open.has(id)) useCompare.getState().close(id);
});
