import { beforeEach, describe, expect, it, vi } from 'vitest';

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
const queryCancel = vi.fn();
const queryCancelAux = vi.fn();
const connDisconnect = vi.fn();

vi.mock('@/lib/ipc', () => ({
  ipc: {
    query: {
      run: (...args: unknown[]) => queryRun(...args),
      cancel: (...args: unknown[]) => queryCancel(...args),
      cancelAux: (...args: unknown[]) => queryCancelAux(...args),
    },
    sql: { format: vi.fn() },
    conn: {
      test: vi.fn(),
      connect: vi.fn(),
      disconnect: (...a: unknown[]) => connDisconnect(...a),
    },
    schema: { introspect: vi.fn() },
    settings: { get: vi.fn(), set: vi.fn(async () => undefined) },
    history: { list: vi.fn(async () => []), clear: vi.fn() },
    txn: { begin: vi.fn(), commit: vi.fn(), rollback: vi.fn() },
    ai: { ask: vi.fn(), cancel: vi.fn() },
  },
}));

import { useSession } from './session';
import { cancelTuning } from './session-query';

const ok = {
  columns: [{ name: 'n', dataTypeId: 23 }],
  rows: [[1]],
  rowCount: 1,
  command: 'SELECT',
  durationMs: 1,
};

function tab(id: string, sql: string) {
  return {
    id,
    title: `${id}.sql`,
    kind: 'sql' as const,
    sql,
    queryRunState: 'idle' as const,
    queryResult: null,
    queryError: null,
    queryErrorSql: null,
    queryGeneration: 0,
    formatGeneration: 0,
    page: 0,
    pageSize: 50,
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
}

const life = (id: string) => useSession.getState().tabs.find((t) => t.id === id)?.queryLifecycle;
const tabOf = (id: string) => useSession.getState().tabs.find((t) => t.id === id);
const flush = () => new Promise((r) => setTimeout(r, 0));
const LOST = new Error('Connection terminated unexpectedly');

describe('review fixes: lifecycle in the store', () => {
  beforeEach(() => {
    queryRun.mockReset();
    queryCancel.mockReset();
    queryCancelAux.mockReset();
    connDisconnect.mockReset();
    queryCancel.mockResolvedValue('sent');
    queryCancelAux.mockResolvedValue(undefined);
    connDisconnect.mockResolvedValue(undefined);
    cancelTuning.retryMs = 1;
    useSession.setState({
      tabs: [
        tab('a', 'SELECT 1'),
        tab('w', 'UPDATE t SET x = 1 WHERE id = 1'),
        tab('c', 'COMMIT'),
        tab(
          's',
          'UPDATE a SET x = 1 WHERE id = 1; UPDATE b SET x = 1 WHERE id = 1; UPDATE c SET x = 1 WHERE id = 1',
        ),
      ],
      activeTabId: 'w',
      prodGate: null,
      safeRun: null,
      activeConfig: null,
      connectionState: 'connected',
      connectionGen: 1,
    });
  });

  // ── P1-1 ──
  it('P1-1: Disconnect to stop it keeps a write as outcome unknown, and the late failure still lands', async () => {
    const run = deferred<typeof ok>();
    queryRun.mockReturnValueOnce(run.promise);
    const p = useSession.getState().runQuery();
    await flush();
    await useSession.getState().cancelQuery();
    expect(life('w')?.phase).toBe('cancelling');
    await useSession.getState().disconnect();
    expect(life('w')).toMatchObject({ phase: 'unknown', sql: 'UPDATE t SET x = 1 WHERE id = 1' });
    expect(tabOf('w')?.queryError).toMatch(/may or may not have been applied/);
    expect(tabOf('w')?.queryRunState).toBe('idle');
    run.reject(LOST);
    await p;
    expect(life('w')?.phase).toBe('unknown');
    expect(tabOf('w')?.queryError).toMatch(/may or may not/);
  });

  it('P1-1: the run failing just before the disconnect finishes is not wiped by it', async () => {
    const run = deferred<typeof ok>();
    queryRun.mockReturnValueOnce(run.promise);
    const p = useSession.getState().runQuery();
    await flush();
    run.reject(LOST);
    await p;
    expect(life('w')?.phase).toBe('unknown');
    await useSession.getState().disconnect();
    expect(life('w')?.phase).toBe('unknown');
    expect(tabOf('w')?.queryError).not.toBeNull();
  });

  it('P1-1: a worker crash mid-write is outcome unknown; mid-read it is disconnected', async () => {
    const run = deferred<typeof ok>();
    queryRun.mockReturnValueOnce(run.promise);
    const p = useSession.getState().runQuery();
    await flush();
    useSession.getState().handleWorkerReset();
    expect(life('w')?.phase).toBe('unknown');
    run.reject(new Error('DB worker exited unexpectedly'));
    await p;
    expect(life('w')?.phase).toBe('unknown');

    useSession.setState({ activeTabId: 'a', connectionGen: 1 });
    const read = deferred<typeof ok>();
    queryRun.mockReturnValueOnce(read.promise);
    const q = useSession.getState().runQuery();
    await flush();
    useSession.getState().handleWorkerReset();
    expect(life('a')?.phase).toBe('disconnected');
    read.reject(new Error('DB worker exited unexpectedly'));
    await q;
    expect(life('a')?.phase).toBe('disconnected');
  });

  // ── P1-2 ──
  it('P1-2: a COMMIT whose reply was lost is outcome unknown, never "rolled back"', async () => {
    useSession.setState({ activeTabId: 'c' });
    queryRun.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'plasma:query:run': Error: Connection lost during an open transaction — the transaction was rolled back by the server and nothing was re-run. (x)",
      ),
    );
    await useSession.getState().runQuery();
    expect(life('c')?.phase).toBe('unknown');
    expect(life('c')?.message).toMatch(/may or may not have been committed/);
    expect(life('c')?.message).not.toMatch(/rolled back/);
  });

  it('P1-2: any other write in a transaction that lost its session is still a certain rollback', async () => {
    queryRun.mockRejectedValueOnce(
      new Error(
        'Connection lost during an open transaction — the transaction was rolled back by the server and nothing was re-run. (x)',
      ),
    );
    await useSession.getState().runQuery();
    expect(life('w')?.phase).toBe('disconnected');
  });

  it('P1-2: an implicit commit (MySQL DDL) is outcome unknown too', async () => {
    useSession.setState({
      activeConfig: { id: 'm', name: 'my', engine: 'mysql' } as never,
      tabs: [...useSession.getState().tabs, tab('d', 'ALTER TABLE t ADD COLUMN x int')],
      activeTabId: 'd',
    });
    queryRun.mockRejectedValueOnce(
      new Error(
        'Connection lost during an open transaction — the transaction was rolled back by the server and nothing was re-run.',
      ),
    );
    await useSession.getState().runQuery();
    expect(life('d')?.phase).toBe('unknown');
  });

  // ── P1-3 ──
  it('P1-3: a cancel that lands between statements stops the script', async () => {
    useSession.setState({ activeTabId: 's' });
    queryCancel.mockResolvedValue('nothing-running');
    const first = deferred<typeof ok>();
    queryRun.mockReturnValueOnce(first.promise);
    const p = useSession.getState().runQuery({ mode: 'buffer' });
    await flush();
    await useSession.getState().cancelQuery();
    first.resolve(ok);
    await p;
    expect(queryRun).toHaveBeenCalledTimes(1);
    expect(life('s')?.phase).toBe('cancelled');
    expect(tabOf('s')?.queryError).toBe('Cancelled. 1 of 3 statements ran; the rest did not.');
    expect(tabOf('s')?.queryResults).toHaveLength(1);
    expect(tabOf('s')?.queryRunState).toBe('idle');
  });

  it('P1-3: a cancel that interrupts statement 2 says how many ran before it', async () => {
    useSession.setState({ activeTabId: 's' });
    queryRun.mockResolvedValueOnce(ok);
    const second = deferred<typeof ok>();
    queryRun.mockReturnValueOnce(second.promise);
    const p = useSession.getState().runQuery({ mode: 'buffer' });
    await flush();
    await flush();
    await useSession.getState().cancelQuery();
    second.reject(new Error('canceling statement due to user request'));
    await p;
    expect(queryRun).toHaveBeenCalledTimes(2);
    expect(life('s')?.phase).toBe('cancelled');
    expect(tabOf('s')?.queryError).toBe('Cancelled during statement 2 of 3. 1 ran before it.');
  });

  it('P1-3: a cancel during a write whose connection then dropped is outcome unknown', async () => {
    useSession.setState({ activeTabId: 's' });
    const first = deferred<typeof ok>();
    queryRun.mockReturnValueOnce(first.promise);
    const p = useSession.getState().runQuery({ mode: 'buffer' });
    await flush();
    await useSession.getState().cancelQuery();
    first.reject(LOST);
    await p;
    expect(life('s')?.phase).toBe('unknown');
    expect(queryRun).toHaveBeenCalledTimes(1);
  });

  // ── P1-4 / P2-2 ──
  it('P1-4: an AI read on the aux connection does not make a primary run look queued', async () => {
    const now = Date.now();
    useSession.setState((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === 'a'
          ? {
              ...t,
              queryRunState: 'running' as const,
              queryLifecycle: { phase: 'running' as const, since: now, startedAt: now, aux: true },
            }
          : t,
      ),
    }));
    const run = deferred<typeof ok>();
    queryRun.mockReturnValueOnce(run.promise);
    const p = useSession.getState().runQuery();
    await flush();
    expect(life('w')?.phase).toBe('running');
    expect(queryRun).toHaveBeenCalledTimes(1);
    // Cancel on the user's tab reaches its own query on the primary connection…
    await useSession.getState().cancelQuery();
    expect(queryCancel).toHaveBeenCalledTimes(1);
    run.reject(new Error('canceling statement due to user request'));
    await p;
    expect(life('w')?.phase).toBe('cancelled');
  });

  it('P1-4: Cancel on an AI (aux) tab stops only the aux connection', async () => {
    const now = Date.now();
    useSession.setState((s) => ({
      activeTabId: 'a',
      tabs: s.tabs.map((t) =>
        t.id === 'a'
          ? {
              ...t,
              queryRunState: 'running' as const,
              queryLifecycle: { phase: 'running' as const, since: now, startedAt: now, aux: true },
            }
          : t,
      ),
    }));
    await useSession.getState().cancelQuery();
    expect(queryCancelAux).toHaveBeenCalledTimes(1);
    expect(queryCancel).not.toHaveBeenCalled();
  });

  it("P1-4: Cancel only ever stops the active tab's own run", async () => {
    const run = deferred<typeof ok>();
    queryRun.mockReturnValueOnce(run.promise);
    useSession.setState({ activeTabId: 'a' });
    const p = useSession.getState().runQuery();
    await flush();
    useSession.setState({ activeTabId: 'w' }); // another, idle tab in view
    await useSession.getState().cancelQuery();
    expect(queryCancel).not.toHaveBeenCalled();
    expect(life('a')?.phase).toBe('running');
    run.resolve(ok);
    await p;
  });

  it('P2-2: a queued run is really held back, can be withdrawn, and never runs', async () => {
    const first = deferred<typeof ok>();
    queryRun.mockReturnValueOnce(first.promise);
    useSession.setState({ activeTabId: 'a' });
    const p1 = useSession.getState().runQuery();
    await flush();
    useSession.setState({ activeTabId: 'w' });
    const p2 = useSession.getState().runQuery();
    await flush();
    expect(life('w')?.phase).toBe('queued');
    expect(queryRun).toHaveBeenCalledTimes(1); // nothing sent for the queued tab
    await useSession.getState().cancelQuery();
    expect(queryCancel).not.toHaveBeenCalled(); // the running tab is untouched
    expect(life('w')?.phase).toBe('cancelled');
    first.resolve(ok);
    await p1;
    await p2;
    expect(queryRun).toHaveBeenCalledTimes(1);
    expect(life('a')?.phase).toBe('succeeded');
    expect(life('w')?.phase).toBe('cancelled');
  });

  it('P2-2: when the run ahead finishes, the queued run is sent', async () => {
    const first = deferred<typeof ok>();
    queryRun.mockReturnValueOnce(first.promise).mockResolvedValueOnce(ok);
    useSession.setState({ activeTabId: 'a' });
    const p1 = useSession.getState().runQuery();
    await flush();
    useSession.setState({ activeTabId: 'w' });
    const p2 = useSession.getState().runQuery();
    await flush();
    expect(queryRun).toHaveBeenCalledTimes(1);
    first.resolve(ok);
    await p1;
    await p2;
    expect(queryRun).toHaveBeenCalledTimes(2);
    expect(life('w')?.phase).toBe('succeeded');
  });

  it('P2-2: closing a queued tab withdraws its run without touching the running one', async () => {
    const first = deferred<typeof ok>();
    queryRun.mockReturnValueOnce(first.promise);
    useSession.setState({ activeTabId: 'a' });
    const p1 = useSession.getState().runQuery();
    await flush();
    useSession.setState({ activeTabId: 'w' });
    const p2 = useSession.getState().runQuery();
    await flush();
    useSession.getState().closeTabsNow(['w']);
    await p2;
    expect(queryCancel).not.toHaveBeenCalled();
    first.resolve(ok);
    await p1;
    expect(queryRun).toHaveBeenCalledTimes(1);
  });

  // ── P2-1 ──
  it('P2-1: a cancel the server did not confirm is reported, not hidden', async () => {
    queryCancel.mockResolvedValue('failed');
    const run = deferred<typeof ok>();
    queryRun.mockReturnValueOnce(run.promise);
    const p = useSession.getState().runQuery();
    await flush();
    await useSession.getState().cancelQuery();
    expect(life('w')?.phase).toBe('cancelling');
    expect(life('w')?.cancelNote).toMatch(/did not confirm the cancel/);
    run.resolve(ok);
    await p;
  });
});
