import type { PendingEdit, QueryTab } from '@/stores/session-types';
import { parseJournal } from '@shared/recovery';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type JournalSource,
  buildJournal,
  debounceFor,
  flushRecoveryJournal,
  installRecoveryJournal,
  suspendRecoveryJournal,
} from './recovery-journal';

function tab(over: Partial<QueryTab>): QueryTab {
  return {
    id: 't',
    title: 'query-1.sql',
    kind: 'sql',
    sql: '',
    filters: [],
    tableSort: [],
    ...over,
  } as QueryTab;
}

function edit(tabId: string, over: Partial<PendingEdit> = {}): PendingEdit {
  return {
    id: `e-${Math.random()}`,
    tabId,
    schema: 'public',
    table: 'users',
    kind: 'update',
    pkValues: { id: '1' },
    column: 'name',
    oldValue: 'ada',
    newValue: 'ADA',
    rowIndex: 0,
    columnIndex: 1,
    ...over,
  };
}

function source(over: Partial<JournalSource> = {}): JournalSource {
  return {
    tabs: [
      tab({ id: 'a', sql: 'select 1' }),
      tab({ id: 'b', kind: 'table', title: 'users', tableSchema: 'public', tableName: 'users' }),
    ],
    activeTabId: 'b',
    tabsConnectionId: 'c1',
    pendingEditsByTab: {},
    txnState: 'none',
    activeConfig: { id: 'c1', name: 'Local', engine: 'postgres' },
    savedConnections: [{ id: 'c1', name: 'Local' }],
    ...over,
  };
}

describe('buildJournal', () => {
  it('captures the tab strip, unsaved SQL and the active tab', () => {
    const j = buildJournal(source(), 5);
    expect(j).toMatchObject({ v: 1, savedAt: 5, connectionId: 'c1', connectionName: 'Local' });
    expect(j?.strip.activeIndex).toBe(1);
    expect(j?.strip.tabs.map((t) => t.kind)).toEqual(['sql', 'table']);
    expect(j?.strip.tabs[0]?.sql).toBe('select 1');
  });

  it('ties staged edits to their tab by position, with the original values', () => {
    const j = buildJournal(
      source({ pendingEditsByTab: { b: [edit('b', { oldValue: 'ada', oldType: 'text' })] } }),
      1,
    );
    expect(j?.edits).toHaveLength(1);
    expect(j?.edits[0]).toMatchObject({
      tabIndex: 1,
      kind: 'update',
      column: 'name',
      oldValue: 'ada',
      oldType: 'text',
      newValue: 'ADA',
    });
  });

  it('positions skip tabs that are not saved, so edits still land on the right tab', () => {
    const j = buildJournal(
      source({
        tabs: [
          tab({ id: 'big', sql: 'x'.repeat(2_100_000) }),
          tab({
            id: 'b',
            kind: 'table',
            title: 'users',
            tableSchema: 'public',
            tableName: 'users',
          }),
        ],
        activeTabId: 'b',
        pendingEditsByTab: { b: [edit('b')] },
      }),
      1,
    );
    expect(j?.strip.tabs).toHaveLength(1);
    expect(j?.edits[0]?.tabIndex).toBe(0);
  });

  it('records an open transaction', () => {
    expect(buildJournal(source({ txnState: 'active' }), 1)?.txnActive).toBe(true);
    expect(buildJournal(source({ txnState: 'error' }), 1)?.txnActive).toBe(true);
    expect(buildJournal(source({ txnState: 'none' }), 1)?.txnActive).toBe(false);
  });

  it('writes nothing for tabs that belong to another connection, or a non-SQL engine', () => {
    expect(buildJournal(source({ tabsConnectionId: 'other' }), 1)).toBeNull();
    expect(buildJournal(source({ activeConfig: { id: 'c1', engine: 'redis' } }), 1)).toBeNull();
    expect(buildJournal(source({ activeConfig: null }), 1)).toBeNull();
  });

  it('after the worker restarted (no active config), the last live connection still owns the tabs', () => {
    const j = buildJournal(
      source({ activeConfig: null, pendingEditsByTab: { b: [edit('b')] } }),
      1,
      'c1',
    );
    expect(j?.connectionId).toBe('c1');
    expect(j?.connectionName).toBe('Local');
    expect(j?.edits).toHaveLength(1);
  });

  it('is valid for the strict parser, whatever is staged', () => {
    const j = buildJournal(
      source({
        pendingEditsByTab: {
          b: [
            edit('b'),
            edit('b', {
              kind: 'delete',
              column: '',
              oldValue: [1, 'x', 10n] as unknown,
              originalRow: [{ column: 'id', value: '1' }],
            }),
            edit('b', {
              kind: 'insert',
              pkValues: {},
              column: '',
              values: { id: '3', name: null },
            }),
          ],
        },
      }),
      1,
    );
    expect(parseJournal(JSON.parse(JSON.stringify(j)))).not.toBeNull();
  });

  it('never carries results or previews', () => {
    const j = buildJournal(
      source({
        tabs: [
          tab({
            id: 'a',
            sql: 'select 1',
            queryResult: { rows: [[1]], columns: [] } as never,
            safeRun: { pending: true } as never,
          }),
        ],
        activeTabId: 'a',
      }),
      1,
    );
    expect(JSON.stringify(j)).not.toContain('safeRun');
    expect(JSON.stringify(j)).not.toContain('"rows"');
  });
});

describe('installRecoveryJournal', () => {
  type S = JournalSource & { connectionState?: string };
  let state: S;
  let listeners: Array<(s: S, p: S) => void>;
  // biome-ignore lint/suspicious/noExplicitAny: a recording stub
  const api = { save: vi.fn(), flush: vi.fn(async (_journal?: any) => true) };
  const events = new Map<string, () => void>();
  const win = {
    addEventListener: (n: string, f: () => void) => events.set(n, f),
    removeEventListener: (n: string) => events.delete(n),
  };
  const store = {
    getState: () => state,
    subscribe: (l: (s: S, p: S) => void) => {
      listeners.push(l);
      return () => undefined;
    },
  };
  const set = (patch: Partial<S>) => {
    const prev = state;
    state = { ...state, ...patch };
    for (const l of listeners) l(state, prev);
  };

  let dispose: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    listeners = [];
    events.clear();
    api.save.mockClear();
    api.flush.mockClear();
    state = { ...source(), connectionState: 'connected' };
    dispose = installRecoveryJournal(store, api, win as never);
  });
  afterEach(() => {
    dispose();
    vi.useRealTimers();
  });

  it('writes shortly after a change, coalescing a burst into one write', () => {
    set({ tabs: [tab({ id: 'a', sql: 's' })], activeTabId: 'a' });
    set({ tabs: [tab({ id: 'a', sql: 'se' })], activeTabId: 'a' });
    set({ tabs: [tab({ id: 'a', sql: 'sel' })], activeTabId: 'a' });
    expect(api.save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(api.save.mock.calls[0]?.[0].strip.tabs[0].sql).toBe('sel');
    // the debounced path skips the fsync; blur / hide / unload ask for it
    expect(api.save.mock.calls[0]?.[1]).toBe(false);
  });

  it('does not rewrite an identical snapshot (results arriving change tabs, not the strip)', () => {
    set({ pendingEditsByTab: { b: [edit('b')] } });
    vi.advanceTimersByTime(300);
    set({ tabs: [...state.tabs] });
    vi.advanceTimersByTime(300);
    expect(api.save).toHaveBeenCalledTimes(1);
  });

  it('flushes at once when the window loses focus, hides or unloads', () => {
    set({ pendingEditsByTab: { b: [edit('b')] } });
    events.get('blur')?.();
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(api.save.mock.calls[0]?.[1]).toBe(true);
    set({ pendingEditsByTab: { b: [edit('b'), edit('b', { column: 'age' })] } });
    events.get('beforeunload')?.();
    expect(api.save).toHaveBeenCalledTimes(2);
    expect(api.save.mock.calls[1]?.[0].edits).toHaveLength(2);
  });

  it('can be flushed and awaited', async () => {
    set({ pendingEditsByTab: { b: [edit('b')] } });
    await expect(flushRecoveryJournal()).resolves.toBe(true);
    expect(api.flush).toHaveBeenCalledOnce();
    expect(api.flush.mock.calls[0]?.[0].edits).toHaveLength(1);
  });

  it('keeps writing staged edits after the worker restarts and the active connection is gone', () => {
    set({ activeConfig: null, connectionState: 'idle', pendingEditsByTab: { b: [edit('b')] } });
    vi.advanceTimersByTime(300);
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(api.save.mock.calls[0]?.[0].connectionId).toBe('c1');
    expect(api.save.mock.calls[0]?.[0].edits).toHaveLength(1);
  });

  it('a deliberate disconnect clears the snapshot and stays quiet until a connection is live', () => {
    suspendRecoveryJournal();
    expect(api.save).toHaveBeenLastCalledWith(null);
    set({ activeConfig: null, connectionState: 'idle', tabs: [tab({ id: 'z', sql: 'x' })] });
    vi.advanceTimersByTime(300);
    expect(api.save).toHaveBeenCalledTimes(1);
    set({
      activeConfig: { id: 'c1', engine: 'postgres' },
      connectionState: 'connected',
      tabs: [tab({ id: 'y', sql: 'y' })],
      activeTabId: 'y',
    });
    vi.advanceTimersByTime(300);
    expect(api.save).toHaveBeenCalledTimes(2);
  });
});

describe('buildJournal: target, in-flight commits, size limits (P2-3, P2-6, P2-7, P1-4)', () => {
  const withHost = (over: Partial<JournalSource> = {}) =>
    source({
      activeConfig: {
        id: 'c1',
        name: 'Local',
        engine: 'postgres',
        host: 'db.example',
        port: 5432,
        database: 'prod',
        user: 'app',
      },
      ...over,
    });

  it('records where it was taken (no secrets)', () => {
    const j = buildJournal(withHost(), 1);
    expect(j?.target).toEqual({
      engine: 'postgres',
      host: 'db.example',
      port: 5432,
      database: 'prod',
      user: 'app',
    });
    expect(JSON.stringify(j)).not.toMatch(/password/i);
  });

  it('flags the edits whose commit is in flight', () => {
    const e1 = edit('b', { id: 'in-flight' });
    const e2 = edit('b', { id: 'other', column: 'age' });
    const j = buildJournal(
      source({ pendingEditsByTab: { b: [e1, e2] }, commitInFlightIds: ['in-flight'] }),
      1,
    );
    expect(j?.edits.map((e) => e.maybeCommitted)).toEqual([true, undefined]);
  });

  it('keeps an edit flagged once it was restored as "may already be saved"', () => {
    const j = buildJournal(
      source({ pendingEditsByTab: { b: [edit('b', { maybeCommitted: true })] } }),
      1,
    );
    expect(j?.edits[0]?.maybeCommitted).toBe(true);
  });

  it('includes a big SQL buffer up to the journal limit and names one that is over it', () => {
    const j = buildJournal(
      source({
        tabs: [
          tab({ id: 'mid', title: 'mid.sql', sql: 'x'.repeat(900_000) }),
          tab({ id: 'big', title: 'big.sql', sql: 'x'.repeat(2_100_000) }),
        ],
        activeTabId: 'mid',
      }),
      1,
    );
    expect(j?.strip.tabs.map((t) => t.title)).toEqual(['mid.sql']);
    expect(j?.omitted).toEqual({ tabs: ['big.sql'], edits: 0 });
  });

  it('does not journal a DuckDB data-file session (nothing to reconnect to)', () => {
    expect(
      buildJournal(
        source({
          tabsConnectionId: 'duckdb-abc123',
          activeConfig: { id: 'duckdb-abc123', engine: 'duckdb' },
        }),
        1,
      ),
    ).toBeNull();
  });
});

describe('debounceFor', () => {
  it('waits longer for a big snapshot, up to a cap', () => {
    expect(debounceFor(1_000)).toBe(250);
    expect(debounceFor(1_000_000)).toBe(1250);
    expect(debounceFor(50_000_000)).toBe(2250);
  });
});
