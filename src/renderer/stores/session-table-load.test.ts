import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryRun = vi.fn();
const sideband = vi.fn();
const introspect = vi.fn();

vi.mock('@/lib/ipc', () => ({
  ipc: {
    query: {
      run: (...a: unknown[]) => queryRun(...a),
      sideband: (...a: unknown[]) => sideband(...a),
      cancel: vi.fn(async () => undefined),
    },
    conn: { introspect: (...a: unknown[]) => introspect(...a) },
    settings: { get: vi.fn(), set: vi.fn(async () => undefined) },
    vault: { list: vi.fn(async () => []) },
    history: { list: vi.fn(async () => []) },
  },
}));

import { useSession } from './session';
import { lastPageIndex, runTableCountQuery } from './session-table-query';
import { adoptConnectionTabs } from './session-tabs';

const schemaNoColumns = {
  schemas: [{ name: 'public' }, { name: 'analytics' }],
  tables: [{ schema: 'analytics', name: 'events', kind: 'table', rowCountEstimate: 1 }],
  columns: [],
  foreignKeys: [],
  routines: [],
  sequences: [],
  types: [],
  extensions: [],
};

const eventColumns = [
  {
    schema: 'analytics',
    table: 'events',
    name: 'id',
    dataType: 'int4',
    ordinal: 1,
    isPrimaryKey: true,
    isNullable: false,
    hasDefault: false,
  },
  {
    schema: 'analytics',
    table: 'events',
    name: 'secret',
    dataType: 'text',
    ordinal: 2,
    isPrimaryKey: false,
    isNullable: true,
    hasDefault: false,
  },
];

beforeEach(() => {
  queryRun.mockReset();
  sideband.mockReset();
  introspect.mockReset();
  queryRun.mockResolvedValue({ columns: [], rows: [], rowCount: 0, durationMs: 1 });
  sideband.mockResolvedValue({ columns: [], rows: [[0]], rowCount: 1, durationMs: 1 });
  introspect.mockResolvedValue({ columns: eventColumns, foreignKeys: [] });
  useSession.setState({
    connectionState: 'connected',
    connectionGen: 1,
    activeConfig: { id: 'c', name: 'c', engine: 'postgres' } as never,
    schema: schemaNoColumns as never,
    columnSchemas: new Set(['public']),
  });
});

describe('table tab waits for its schema columns (R-06)', () => {
  it('orders page 0 by the primary key and honours hidden columns', async () => {
    useSession.getState().openTable('analytics', 'events', { newTab: true, preview: false });
    const tabId = useSession.getState().activeTabId;
    useSession.setState((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, hiddenColumns: new Set(['secret']) } : t)),
    }));
    await vi.waitFor(() => expect(queryRun).toHaveBeenCalled());
    const sql = String(queryRun.mock.calls[0]?.[0]);
    expect(sql).toMatch(/ORDER BY "id"/i);
    expect(sql).not.toMatch(/ctid/i);
    expect(sql).not.toMatch(/\*/);
    expect(sql).not.toMatch(/"secret"/);
  });

  it('does not issue the query before the columns arrive', async () => {
    let release!: (v: unknown) => void;
    introspect.mockReturnValue(
      new Promise((r) => {
        release = r;
      }),
    );
    useSession.getState().openTable('analytics', 'events', { newTab: true, preview: false });
    await new Promise((r) => setTimeout(r, 10));
    expect(queryRun).not.toHaveBeenCalled();
    release({ columns: eventColumns, foreignKeys: [] });
    await vi.waitFor(() => expect(queryRun).toHaveBeenCalled());
  });
});

describe('reconnect to the same connection reloads the active table tab (R-07)', () => {
  it('adoptConnectionTabs re-runs the table tab on screen', async () => {
    useSession.setState({ columnSchemas: new Set(['public', 'analytics']) });
    useSession.getState().openTable('analytics', 'events', { newTab: true, preview: false });
    await vi.waitFor(() => expect(queryRun).toHaveBeenCalled());
    const tabId = useSession.getState().activeTabId;
    // What beginSession leaves behind: results cleared, same connection id.
    useSession.setState((s) => ({
      tabsConnectionId: 'c',
      tabs: s.tabs.map((t) => ({
        ...t,
        queryResult: null,
        queryRunState: 'idle' as const,
        countLoading: false,
      })),
    }));
    queryRun.mockClear();
    adoptConnectionTabs(useSession.setState, useSession.getState, 'postgres');
    await vi.waitFor(() => expect(queryRun).toHaveBeenCalled());
    expect(useSession.getState().activeTabId).toBe(tabId);
  });
});

describe('page is clamped once the exact count shows it is out of range (R-32)', () => {
  it('moves to the last page and re-queries', async () => {
    useSession.setState({ columnSchemas: new Set(['public', 'analytics']) });
    useSession.getState().openTable('analytics', 'events', { newTab: true, preview: false });
    await vi.waitFor(() => expect(queryRun).toHaveBeenCalled());
    const tabId = useSession.getState().activeTabId;
    useSession.setState((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, page: 7, pageSize: 50 } : t)),
    }));
    queryRun.mockClear();
    sideband.mockResolvedValue({ columns: [], rows: [['120']], rowCount: 1, durationMs: 1 });
    await runTableCountQuery(useSession.setState as never, useSession.getState, tabId);
    const tab = useSession.getState().tabs.find((t) => t.id === tabId);
    expect(tab?.page).toBe(2);
    await vi.waitFor(() => expect(queryRun).toHaveBeenCalled());
  });

  it('lastPageIndex handles empty tables and exact multiples', () => {
    expect(lastPageIndex(0, 50)).toBe(0);
    expect(lastPageIndex(100, 50)).toBe(1);
    expect(lastPageIndex(101, 50)).toBe(2);
  });
});
