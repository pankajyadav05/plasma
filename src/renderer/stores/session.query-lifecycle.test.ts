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

vi.mock('@/lib/ipc', () => ({
  ipc: {
    query: {
      run: (...args: unknown[]) => queryRun(...args),
      cancel: (...args: unknown[]) => queryCancel(...args),
    },
    sql: { format: vi.fn() },
    conn: { test: vi.fn(), connect: vi.fn(), disconnect: vi.fn() },
    schema: { introspect: vi.fn() },
    settings: { get: vi.fn(), set: vi.fn(async () => undefined) },
    history: { list: vi.fn(async () => []), clear: vi.fn() },
    txn: { begin: vi.fn(), commit: vi.fn(), rollback: vi.fn() },
    ai: { ask: vi.fn(), cancel: vi.fn() },
  },
}));

import { useSession } from './session';

const ok = {
  columns: [{ name: 'n', dataTypeId: 23 }],
  rows: [[1]],
  rowCount: 1,
  command: 'SELECT',
  durationMs: 1,
};

function tab(id: string, sql: string) {
  const pageSize = useSession.getState().settings.defaultPageSize;
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
}

const phaseOf = (id: string) => useSession.getState().tabs.find((t) => t.id === id)?.queryLifecycle;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('C1 query lifecycle in the store', () => {
  beforeEach(() => {
    queryRun.mockReset();
    queryCancel.mockReset();
    queryCancel.mockResolvedValue('sent');
    useSession.setState({
      tabs: [
        tab('a', 'SELECT 1'),
        tab('b', 'SELECT 2'),
        tab('w', 'UPDATE t SET x = 1 WHERE id = 1'),
      ],
      activeTabId: 'a',
      prodGate: null,
      safeRun: null,
      activeConfig: null,
      connectionState: 'idle',
      connectionGen: 1,
    });
  });

  it('running → succeeded', async () => {
    const d = deferred<typeof ok>();
    queryRun.mockReturnValueOnce(d.promise);
    const p = useSession.getState().runQuery();
    await flush();
    expect(phaseOf('a')?.phase).toBe('running');
    d.resolve(ok);
    await p;
    expect(phaseOf('a')?.phase).toBe('succeeded');
    expect(useSession.getState().tabs[0]?.queryRunState).toBe('idle');
  });

  it('a SQL error is failed and keeps the message', async () => {
    queryRun.mockRejectedValueOnce(new Error('syntax error at or near "x"'));
    await useSession.getState().runQuery();
    expect(phaseOf('a')?.phase).toBe('failed');
    expect(useSession.getState().tabs[0]?.queryError).toContain('syntax error');
  });

  it('cancel: running → cancelling → cancelled when the engine reports its cancel error', async () => {
    const d = deferred<typeof ok>();
    queryRun.mockReturnValueOnce(d.promise);
    const p = useSession.getState().runQuery();
    await flush();
    await useSession.getState().cancelQuery();
    expect(phaseOf('a')?.phase).toBe('cancelling');
    d.reject(new Error('canceling statement due to user request'));
    await p;
    expect(phaseOf('a')?.phase).toBe('cancelled');
    expect(useSession.getState().tabs[0]?.queryRunState).toBe('idle');
  });

  it('cancel that finds nothing running goes back to running, then the result wins', async () => {
    queryCancel.mockResolvedValue('nothing-running');
    const d = deferred<typeof ok>();
    queryRun.mockReturnValueOnce(d.promise);
    const p = useSession.getState().runQuery();
    await flush();
    await useSession.getState().cancelQuery();
    expect(phaseOf('a')?.phase).toBe('running');
    d.resolve(ok);
    await p;
    expect(phaseOf('a')?.phase).toBe('succeeded');
  });

  it('a result that arrives after the cancel request still succeeds (cancel after finish race)', async () => {
    const d = deferred<typeof ok>();
    queryRun.mockReturnValueOnce(d.promise);
    const p = useSession.getState().runQuery();
    await flush();
    const cancelling = useSession.getState().cancelQuery();
    d.resolve(ok);
    await p;
    await cancelling;
    expect(phaseOf('a')?.phase).toBe('succeeded');
    expect(phaseOf('a')?.finishedBeforeCancel).toBe(true);
  });

  it('cancel after the run finished does not touch the tab', async () => {
    queryRun.mockResolvedValueOnce(ok);
    await useSession.getState().runQuery();
    const before = phaseOf('a');
    await useSession.getState().cancelQuery();
    expect(phaseOf('a')).toBe(before);
  });

  it('a refused cancel keeps cancelling with a note; Disconnect to stop it is available', async () => {
    queryCancel.mockResolvedValue('unsupported');
    const d = deferred<typeof ok>();
    queryRun.mockReturnValueOnce(d.promise);
    const p = useSession.getState().runQuery();
    await flush();
    await useSession.getState().cancelQuery();
    expect(phaseOf('a')).toMatchObject({ phase: 'cancelling' });
    expect(phaseOf('a')?.cancelNote).toMatch(/cannot stop/);
    d.resolve(ok);
    await p;
  });

  it('connection lost during a read is disconnected', async () => {
    queryRun.mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));
    await useSession.getState().runQuery();
    expect(phaseOf('a')?.phase).toBe('disconnected');
  });

  it('connection lost during a write is outcome unknown, with the SQL kept', async () => {
    useSession.setState({ activeTabId: 'w' });
    queryRun.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'plasma:query:run': Error: Connection lost — the statement was not re-run; it may or may not have been applied. (x)",
      ),
    );
    await useSession.getState().runQuery();
    expect(phaseOf('w')).toMatchObject({
      phase: 'unknown',
      sql: 'UPDATE t SET x = 1 WHERE id = 1',
    });
  });

  it('the connection changing mid-write is outcome unknown', async () => {
    useSession.setState({ activeTabId: 'w' });
    const d = deferred<typeof ok>();
    queryRun.mockReturnValueOnce(d.promise);
    const p = useSession.getState().runQuery();
    await flush();
    useSession.setState({ connectionGen: 2 });
    d.resolve(ok);
    await p;
    expect(phaseOf('w')?.phase).toBe('unknown');
  });

  it('a second tab queues behind a running one and starts when it finishes', async () => {
    const d1 = deferred<typeof ok>();
    const d2 = deferred<typeof ok>();
    queryRun.mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise);
    const p1 = useSession.getState().runQuery();
    await flush();
    useSession.setState({ activeTabId: 'b' });
    const p2 = useSession.getState().runQuery();
    await flush();
    expect(phaseOf('a')?.phase).toBe('running');
    expect(phaseOf('b')?.phase).toBe('queued');
    d1.resolve(ok);
    await p1;
    await flush();
    expect(phaseOf('a')?.phase).toBe('succeeded');
    expect(phaseOf('b')?.phase).toBe('running');
    d2.resolve(ok);
    await p2;
    expect(phaseOf('b')?.phase).toBe('succeeded');
  });

  it('cancel on a queued tab does not stop the query holding the connection', async () => {
    const d1 = deferred<typeof ok>();
    queryRun.mockReturnValueOnce(d1.promise).mockReturnValueOnce(new Promise(() => {}));
    void useSession.getState().runQuery();
    await flush();
    useSession.setState({ activeTabId: 'b' });
    void useSession.getState().runQuery();
    await flush();
    await useSession.getState().cancelQuery();
    expect(queryCancel).not.toHaveBeenCalled();
    expect(phaseOf('a')?.phase).toBe('running');
  });

  it('the legacy running flag still follows the lifecycle for table-style callers', () => {
    useSession.setState({ activeTabId: 'a' });
    useSession.setState((s) => ({
      tabs: s.tabs.map((t) => (t.id === 'a' ? { ...t, queryRunState: 'running' as const } : t)),
    }));
    expect(useSession.getState().tabs[0]?.queryRunState).toBe('running');
  });
});
