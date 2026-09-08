/**
 * E-QUERY publish-boundary probes (week-1 L1 companions).
 *
 * These encode the release-main regressions from
 * reports/release-main-breakage.md §A1 / §A2:
 *   - E-QUERY disconnect-while-in-flight must not restore old rows
 *   - E-QUERY stale success must not clear newer running state
 *
 * They exercise real useSession.runQuery() with deferred IPC (same pattern
 * as session.origin-tab.test.ts). Pass on main/v0.0.18; fail on the divergent
 * release-main publishOrigin that dropped the connectionGen guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const queryRun = vi.fn();
const sqlFormat = vi.fn();
const connDisconnect = vi.fn(async () => undefined);

vi.mock('@/lib/ipc', () => ({
  ipc: {
    query: {
      run: (...args: unknown[]) => queryRun(...args),
      cancel: vi.fn(async () => undefined),
    },
    sql: {
      format: (...args: unknown[]) => sqlFormat(...args),
    },
    conn: {
      test: vi.fn(),
      connect: vi.fn(),
      disconnect: () => connDisconnect(),
      list: vi.fn(async () => []),
      get: vi.fn(),
      delete: vi.fn(),
    },
    schema: { introspect: vi.fn() },
    settings: { get: vi.fn(), set: vi.fn(async () => undefined) },
    history: { list: vi.fn(async () => []), clear: vi.fn() },
    txn: { begin: vi.fn(), commit: vi.fn(), rollback: vi.fn() },
    ai: { ask: vi.fn(), cancel: vi.fn() },
  },
}));

import { useSession } from './session';

const sampleResult = {
  columns: [{ name: 'n', dataTypeId: 23 }],
  rows: [[1]],
  rowCount: 1,
  command: 'SELECT',
  durationMs: 1,
};

function resetStore() {
  const pageSize = useSession.getState().settings.defaultPageSize;
  const freshA = {
    id: 'tab-a',
    title: 'a.sql',
    kind: 'sql' as const,
    sql: 'SELECT 1; SELECT 2',
    queryRunState: 'idle' as const,
    queryResult: null,
    queryError: null,
    queryErrorSql: null,
    queryGeneration: 0,
    formatGeneration: 0,
    page: 0,
    pageSize,
    sortColumn: null,
    selectedCell: null,
    selectedRows: new Set<number>(),
    columnWidths: {},
    tableSort: [],
    filters: [],
    hiddenColumns: new Set<string>(),
    stickyColumns: new Set<string>(),
    totalRowCount: null,
    totalRowCountIsEstimate: false,
    countLoading: false,
    viewMode: 'data' as const,
    rlsPolicyCount: null,
  };
  useSession.setState({
    tabs: [freshA],
    activeTabId: 'tab-a',
    prodGate: null,
    activeConfig: {
      id: 'c1',
      name: 'c1',
      engine: 'postgres',
      host: 'localhost',
      port: 5432,
      database: 'db',
      user: 'u',
      password: '',
      ssl: false,
    },
    connectionState: 'connected',
    connectionGen: 1,
  });
}

describe('E-QUERY publish boundary (release-main A1/A2)', () => {
  beforeEach(() => {
    queryRun.mockReset();
    sqlFormat.mockReset();
    connDisconnect.mockClear();
    resetStore();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('E-QUERY disconnect-while-in-flight must not restore old rows', async () => {
    // Statement 1 resolves; statement 2 stays pending. Disconnect clears
    // results. Late rejection of statement 2 must NOT republish statement-1 rows.
    const pending2 = deferred<typeof sampleResult>();
    queryRun.mockReturnValueOnce(Promise.resolve(sampleResult)).mockReturnValueOnce(pending2.promise);

    const runPromise = useSession.getState().runQuery();
    // Let statement 1 land.
    await Promise.resolve();
    await Promise.resolve();

    const mid = useSession.getState().tabs.find((t) => t.id === 'tab-a');
    expect(mid?.queryResult?.rows).toEqual([[1]]);

    await useSession.getState().disconnect();
    expect(useSession.getState().tabs.find((t) => t.id === 'tab-a')?.queryResult).toBeNull();
    expect(useSession.getState().connectionGen).toBe(0);

    pending2.reject(new Error('old database error'));
    await runPromise;

    const tab = useSession.getState().tabs.find((t) => t.id === 'tab-a');
    // Must stay cleared — buggy publishOrigin would restore [[1]].
    expect(tab?.queryResult).toBeNull();
    // May surface a connection-changed discard message; must not be the old DB error alone with rows.
    if (tab?.queryError) {
      expect(tab.queryError).not.toMatch(/^old database error$/);
    }
  });

  it('E-QUERY stale success must not clear newer running state', async () => {
    // Old query pending; advance connectionGen + queryGeneration to represent a
    // newer running request; resolve the old query. Stale success must not
    // force the newer owner to idle.
    const pending = deferred<typeof sampleResult>();
    queryRun.mockReturnValueOnce(pending.promise);

    const runPromise = useSession.getState().runQuery();
    const genAfterStart = useSession.getState().tabs.find((t) => t.id === 'tab-a')!.queryGeneration;
    expect(genAfterStart).toBe(1);

    useSession.setState((s) => ({
      connectionGen: (s.connectionGen ?? 0) + 1,
      tabs: s.tabs.map((t) =>
        t.id === 'tab-a'
          ? { ...t, queryGeneration: genAfterStart + 1, queryRunState: 'running' as const, queryError: null }
          : t,
      ),
    }));

    pending.resolve(sampleResult);
    await runPromise;

    const tabA = useSession.getState().tabs.find((t) => t.id === 'tab-a');
    expect(tabA?.queryRunState).toBe('running');
    expect(tabA?.queryResult).toBeNull();
    expect(tabA?.queryError).toBeNull();
  });
});
