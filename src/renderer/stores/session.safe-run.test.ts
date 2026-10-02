import type { SafeRunReport } from '@shared/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryRun = vi.fn();
const safeRun = vi.fn();
const safeRunFinish = vi.fn();
const cancel = vi.fn(async () => undefined);

vi.mock('@/lib/ipc', () => ({
  ipc: {
    query: {
      run: (...args: unknown[]) => queryRun(...args),
      cancel: () => cancel(),
      safeRun: (...args: unknown[]) => safeRun(...args),
      safeRunFinish: (...args: unknown[]) => safeRunFinish(...args),
    },
    sql: { format: vi.fn() },
    conn: {
      test: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
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

const col = (name: string) => ({ name, dataTypeID: 25, dataTypeName: 'text' });

function report(over: Partial<SafeRunReport> = {}): SafeRunReport {
  return {
    runId: 'run-1',
    kind: 'delete',
    statement: 'DELETE FROM users WHERE id = 1',
    nested: false,
    affected: 1,
    affectedExact: true,
    estimateRows: 1,
    mode: 'diff',
    note: null,
    keyKind: 'pk',
    keyColumns: ['id'],
    beforeColumns: [col('id')],
    before: [[1]],
    beforeCtids: null,
    beforeTotal: 1,
    afterColumns: [col('id')],
    after: [[1]],
    afterCtids: null,
    afterTotal: 1,
    durationMs: 3,
    expiresAt: Date.now() + 300_000,
    timeoutSec: 300,
    txnState: 'active',
    ...over,
  };
}

function tab(id: string, sql: string) {
  return {
    id,
    title: `${id}.sql`,
    kind: 'sql',
    sql,
    queryRunState: 'idle',
    queryResult: null,
    queryResults: [],
    activeResultIndex: 0,
    queryError: null,
    queryErrorSql: null,
    page: 0,
    pageSize: 50,
    sortColumn: null,
    selectedCell: null,
    selectedRows: new Set(),
    columnWidths: {},
    tableSort: [],
    filters: [],
    hiddenColumns: new Set(),
    stickyColumns: new Set(),
    totalRowCount: null,
    totalRowCountIsEstimate: false,
    countLoading: false,
    viewMode: 'data',
    rlsPolicyCount: null,
  };
}

function resetStore(opts: { tag?: 'prod'; sql?: string; readOnly?: boolean } = {}) {
  useSession.setState({
    activeConfig: {
      id: 'c1',
      name: 'db',
      engine: 'postgres',
      host: 'localhost',
      port: 5432,
      database: 'app',
      user: 'u',
      password: '',
      ssl: false,
      readOnly: opts.readOnly,
    },
    connectionState: 'connected',
    connectionGen: 7,
    txnState: 'none',
    settings: {
      ...useSession.getState().settings,
      connectionTags: opts.tag ? { c1: opts.tag } : {},
      connectionAlwaysSafeRun: {},
      connectionSafeMode: { c1: 'off' },
    },
    prodGate: null,
    safeRun: null,
    tabs: [tab('t1', opts.sql ?? 'DELETE FROM users WHERE id = 1')],
    activeTabId: 't1',
  } as never);
}

const state = () => useSession.getState();

beforeEach(() => {
  queryRun.mockReset();
  safeRun.mockReset();
  safeRunFinish.mockReset();
  cancel.mockClear();
  resetStore();
});

describe('Safe Run slice', () => {
  it('runs the statement, shows the review, then commits', async () => {
    safeRun.mockResolvedValue(report());
    await state().runSafeRun();
    expect(safeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: 'DELETE FROM users WHERE id = 1',
        connectionGen: 7,
        timeoutSec: 300,
        explain: true,
      }),
    );
    expect(state().safeRun?.phase).toBe('review');

    safeRunFinish.mockResolvedValue({ runId: 'run-1', outcome: 'committed', txnState: 'none' });
    await state().commitSafeRun();
    expect(safeRunFinish).toHaveBeenCalledWith({ runId: 'run-1', action: 'commit' });
    expect(state().safeRun?.phase).toBe('committed');
    expect(state().tabs[0]?.queryResult).toMatchObject({ rowCount: 1, command: 'DELETE' });
  });

  it('rolls back on request and records nothing', async () => {
    safeRun.mockResolvedValue(report());
    await state().runSafeRun();
    safeRunFinish.mockResolvedValue({
      runId: 'run-1',
      outcome: 'rolledBack',
      reason: 'user',
      txnState: 'none',
    });
    await state().rollbackSafeRun();
    expect(safeRunFinish).toHaveBeenCalledWith({ runId: 'run-1', action: 'rollback' });
    expect(state().safeRun?.phase).toBe('rolledBack');
    expect(state().tabs[0]?.queryResult).toBeNull();
  });

  it('says so when the worker already rolled back on its timeout', async () => {
    safeRun.mockResolvedValue(report());
    await state().runSafeRun();
    safeRunFinish.mockResolvedValue({
      runId: 'run-1',
      outcome: 'rolledBack',
      reason: 'timeout',
      txnState: 'none',
    });
    await state().rollbackSafeRun('timeout');
    expect(state().safeRun).toMatchObject({ phase: 'rolledBack', endReason: 'timeout' });
    expect(state().safeRun?.error).toMatch(/ran out/);
  });

  it('shows a failed commit as failed, never as saved', async () => {
    safeRun.mockResolvedValue(report());
    await state().runSafeRun();
    safeRunFinish.mockRejectedValue(new Error('deferred constraint violated'));
    await state().commitSafeRun();
    expect(state().safeRun?.phase).toBe('failed');
    expect(state().safeRun?.error).toMatch(/Nothing was saved/);
  });

  it('rolls back automatically when its tab is closed', async () => {
    safeRun.mockResolvedValue(report());
    await state().runSafeRun();
    safeRunFinish.mockResolvedValue({ runId: 'run-1', outcome: 'rolledBack', txnState: 'none' });
    useSession.setState({ tabs: [], activeTabId: '' } as never);
    await vi.waitFor(() => expect(safeRunFinish).toHaveBeenCalled());
    expect(safeRunFinish).toHaveBeenCalledWith({ runId: 'run-1', action: 'rollback' });
    await vi.waitFor(() => expect(state().safeRun).toBeNull());
  });

  it('closing the panel rolls the pending run back', async () => {
    safeRun.mockResolvedValue(report());
    await state().runSafeRun();
    safeRunFinish.mockResolvedValue({ runId: 'run-1', outcome: 'rolledBack', txnState: 'none' });
    state().dismissSafeRun();
    await vi.waitFor(() => expect(state().safeRun).toBeNull());
    expect(safeRunFinish).toHaveBeenCalledWith({ runId: 'run-1', action: 'rollback' });
  });

  it('marks the run rolled back when the connection goes away', async () => {
    safeRun.mockResolvedValue(report());
    await state().runSafeRun();
    useSession.setState({ connectionState: 'idle' } as never);
    expect(state().safeRun).toMatchObject({ phase: 'rolledBack', endReason: 'disconnect' });
    expect(safeRunFinish).not.toHaveBeenCalled();
  });

  it('discards (rolls back) a report that arrives for a dismissed run', async () => {
    let resolve: (r: SafeRunReport) => void = () => {};
    safeRun.mockReturnValue(
      new Promise<SafeRunReport>((r) => {
        resolve = r;
      }),
    );
    safeRunFinish.mockResolvedValue({ runId: 'run-1', outcome: 'rolledBack', txnState: 'none' });
    const running = state().runSafeRun();
    await vi.waitFor(() => expect(state().safeRun?.phase).toBe('running'));
    state().dismissSafeRun();
    expect(cancel).toHaveBeenCalled();
    resolve(report());
    await running;
    expect(safeRunFinish).toHaveBeenCalledWith({ runId: 'run-1', action: 'rollback' });
    expect(state().safeRun).toBeNull();
  });

  it('refuses read-only connections, non-writes and scripts without calling the worker', async () => {
    resetStore({ readOnly: true });
    await state().runSafeRun();
    expect(state().safeRun?.error).toMatch(/read-only/);

    resetStore({ sql: 'SELECT 1' });
    await state().runSafeRun();
    expect(state().safeRun?.error).toMatch(/INSERT, UPDATE, DELETE and MERGE/);

    resetStore();
    await state().runSafeRun({ sql: 'DELETE FROM a; DELETE FROM b' });
    expect(state().safeRun?.error).toMatch(/one statement/);
    expect(safeRun).not.toHaveBeenCalled();
  });

  it('applies safe mode: read-only level refuses', async () => {
    useSession.setState((s) => ({
      settings: { ...s.settings, connectionSafeMode: { c1: 'read-only' } },
    }));
    await state().runSafeRun();
    expect(state().safeRun?.phase).toBe('failed');
    expect(safeRun).not.toHaveBeenCalled();
  });

  it('applies the prod gate and resumes into Safe Run after confirming', async () => {
    resetStore({ tag: 'prod' });
    useSession.setState((s) => ({
      settings: { ...s.settings, connectionAlwaysSafeRun: { c1: false } },
    }));
    await state().runSafeRun();
    expect(safeRun).not.toHaveBeenCalled();
    expect(state().prodGate).toMatchObject({ sql: 'DELETE FROM users WHERE id = 1', safe: true });

    safeRun.mockResolvedValue(report());
    state().confirmProdGate();
    await vi.waitFor(() => expect(state().safeRun?.phase).toBe('review'));
    expect(queryRun).not.toHaveBeenCalled();
  });

  it('blocks plain runs while a Safe Run is pending, with a message', async () => {
    safeRun.mockResolvedValue(report());
    await state().runSafeRun();
    await state().runQuery();
    expect(queryRun).not.toHaveBeenCalled();
    expect(state().tabs[0]?.queryError).toMatch(/Safe Run is waiting/);
    expect(state().safeRun?.nudge).toBe(1);
  });
});

describe('Run on connections that always Safe Run', () => {
  it('sends a prod DML Run through Safe Run, after the prod gate', async () => {
    resetStore({ tag: 'prod' });
    await state().runQuery();
    expect(state().prodGate).not.toBeNull();
    expect(safeRun).not.toHaveBeenCalled();

    safeRun.mockResolvedValue(report());
    state().confirmProdGate();
    await vi.waitFor(() => expect(state().safeRun?.phase).toBe('review'));
    expect(queryRun).not.toHaveBeenCalled();
  });

  it('runs harmless statements and opted-out connections normally', async () => {
    resetStore({ tag: 'prod', sql: 'SELECT 1' });
    queryRun.mockResolvedValue({ columns: [], rows: [], rowCount: 0, durationMs: 1 });
    await state().runQuery();
    expect(queryRun).toHaveBeenCalledTimes(1);
    expect(safeRun).not.toHaveBeenCalled();

    resetStore({ tag: 'prod' });
    useSession.setState((s) => ({
      settings: { ...s.settings, connectionAlwaysSafeRun: { c1: false } },
    }));
    await state().runQuery();
    // Opted out: the prod gate still asks, but the resumed run is a plain one.
    expect(state().prodGate).not.toBeNull();
    queryRun.mockResolvedValue({ columns: [], rows: [], rowCount: 1, durationMs: 1 });
    state().confirmProdGate();
    await vi.waitFor(() => expect(queryRun).toHaveBeenCalledTimes(2));
    expect(safeRun).not.toHaveBeenCalled();
  });

  it('is on explicitly for non-prod connections', async () => {
    useSession.setState((s) => ({
      settings: { ...s.settings, connectionAlwaysSafeRun: { c1: true } },
    }));
    safeRun.mockResolvedValue(report());
    await state().runQuery();
    await vi.waitFor(() => expect(state().safeRun?.phase).toBe('review'));
    expect(queryRun).not.toHaveBeenCalled();
  });
});
