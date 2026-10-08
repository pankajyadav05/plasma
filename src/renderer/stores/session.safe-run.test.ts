import type { SafeRunReport, SafeRunStep } from '@shared/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryRun = vi.fn();
const safeRun = vi.fn();
const safeRunFinish = vi.fn();
const safeRunUndo = vi.fn();
const cancel = vi.fn(async () => undefined);

vi.mock('@/lib/ipc', () => ({
  ipc: {
    query: {
      run: (...args: unknown[]) => queryRun(...args),
      cancel: () => cancel(),
      safeRun: (...args: unknown[]) => safeRun(...args),
      safeRunFinish: (...args: unknown[]) => safeRunFinish(...args),
      safeRunUndo: (...args: unknown[]) => safeRunUndo(...args),
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

  it('refuses read-only connections, non-writes and non-qualifying scripts without calling the worker', async () => {
    resetStore({ readOnly: true });
    await state().runSafeRun();
    expect(state().safeRun?.error).toMatch(/read-only/);

    resetStore({ sql: 'SELECT 1' });
    await state().runSafeRun();
    expect(state().safeRun?.error).toMatch(/INSERT, UPDATE, DELETE and MERGE/);

    // Several statements are a script now; one that does not qualify is refused by number.
    resetStore();
    await state().runSafeRun({ sql: 'DELETE FROM a; SELECT 1' });
    expect(state().safeRun?.error).toMatch(/Statement 2 is a SELECT/);
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

function step(
  index: number,
  status: SafeRunStep['status'],
  over: Partial<SafeRunStep> = {},
): SafeRunStep {
  return {
    index,
    status,
    error: status === 'failed' ? 'duplicate key value violates unique constraint' : null,
    kind: 'update',
    statement: `UPDATE t${index} SET v = 1`,
    affected: status === 'done' ? 2 : 0,
    affectedExact: true,
    estimateRows: null,
    mode: 'after-only',
    note: null,
    keyKind: 'none',
    keyColumns: [],
    beforeColumns: [],
    before: null,
    beforeCtids: null,
    beforeTotal: 0,
    afterColumns: [],
    after: [],
    afterCtids: null,
    afterTotal: 0,
    durationMs: 4,
    beforeTruncated: false,
    afterTruncated: false,
    notices: [],
    ...over,
  };
}

function scriptReport(statuses: SafeRunStep['status'][], over: Partial<SafeRunReport> = {}) {
  const steps = statuses.map((st, i) => step(i + 1, st));
  const failed = steps.find((x) => x.status === 'failed');
  return report({
    kind: 'update',
    statement: 'UPDATE t1 SET v = 1; UPDATE t2 SET v = 1; UPDATE t3 SET v = 1',
    affected: steps.reduce((n, x) => n + x.affected, 0),
    mode: 'after-only',
    before: null,
    after: [],
    steps,
    failedAt: failed?.index ?? null,
    ...over,
  });
}

const SCRIPT = 'UPDATE t1 SET v = 1;\nUPDATE t2 SET v = 1;\nUPDATE t3 SET v = 1;';
describe('Safe Run scripts', () => {
  beforeEach(() => {
    safeRunUndo.mockReset();
    resetStore({ sql: SCRIPT });
  });

  it('sends the whole script and reviews it; commit publishes one result per statement', async () => {
    safeRun.mockResolvedValue(scriptReport(['done', 'done', 'done']));
    await state().runSafeRun({ sql: SCRIPT });
    expect(safeRun).toHaveBeenCalledWith(expect.objectContaining({ sql: SCRIPT }));
    expect(state().safeRun?.phase).toBe('review');

    safeRunFinish.mockResolvedValue({ runId: 'run-1', outcome: 'committed', txnState: 'none' });
    await state().commitSafeRun();
    expect(safeRunFinish).toHaveBeenCalledWith({ runId: 'run-1', action: 'commit' });
    expect(state().safeRun?.phase).toBe('committed');
    expect(state().tabs[0]?.queryResults).toHaveLength(3);
  });

  it('refuses more than 20 statements and non-qualifying scripts without calling the worker', async () => {
    const many = Array.from({ length: 21 }, (_, i) => `DELETE FROM t${i};`).join('\n');
    await state().runSafeRun({ sql: many });
    expect(state().safeRun?.error).toMatch(/at most 20/);
    await state().runSafeRun({ sql: 'DELETE FROM a; COMMIT;' });
    expect(state().safeRun?.error).toMatch(/Statement 2 is a COMMIT/);
    expect(safeRun).not.toHaveBeenCalled();
  });

  it('review -> undo -> review, with the report replaced', async () => {
    safeRun.mockResolvedValue(scriptReport(['done', 'done', 'done']));
    await state().runSafeRun({ sql: SCRIPT });
    safeRunUndo.mockResolvedValue({ report: scriptReport(['done', 'done']), outcome: null });
    await state().undoSafeRun();
    expect(safeRunUndo).toHaveBeenCalledWith({ runId: 'run-1' });
    expect(state().safeRun?.phase).toBe('review');
    expect(state().safeRun?.report?.steps).toHaveLength(2);
    expect(state().safeRun?.finishing).toBeNull();
  });

  it('undoing the only remaining statement is a roll back of the run', async () => {
    safeRun.mockResolvedValue(scriptReport(['done', 'done']));
    await state().runSafeRun({ sql: SCRIPT });
    safeRunUndo.mockResolvedValue({
      report: null,
      outcome: { runId: 'run-1', outcome: 'rolledBack', reason: 'user', txnState: 'none' },
    });
    await state().undoSafeRun();
    expect(state().safeRun).toMatchObject({ phase: 'rolledBack', endReason: 'user' });
  });

  it('an undo that errors returns to the review so the run can still be rolled back', async () => {
    safeRun.mockResolvedValue(scriptReport(['done', 'done']));
    await state().runSafeRun({ sql: SCRIPT });
    safeRunUndo.mockRejectedValue(new Error('busy'));
    await state().undoSafeRun();
    expect(state().safeRun?.phase).toBe('review');
    expect(state().safeRun?.notice).toMatch(/Undo did not go through: busy/);
    safeRunFinish.mockResolvedValue({
      runId: 'run-1',
      outcome: 'rolledBack',
      reason: 'user',
      txnState: 'none',
    });
    await state().rollbackSafeRun();
    expect(state().safeRun?.phase).toBe('rolledBack');
  });

  it('closing the panel during an undo still rolls the run back', async () => {
    safeRun.mockResolvedValue(scriptReport(['done', 'done', 'done']));
    await state().runSafeRun({ sql: SCRIPT });
    let resolve: (v: unknown) => void = () => {};
    safeRunUndo.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    safeRunFinish.mockResolvedValue({ runId: 'run-1', outcome: 'rolledBack', txnState: 'none' });
    const undoing = state().undoSafeRun();
    state().dismissSafeRun();
    resolve({ report: scriptReport(['done', 'done']), outcome: null });
    await undoing;
    expect(safeRunFinish).toHaveBeenCalledWith({ runId: 'run-1', action: 'rollback' });
  });

  it('a failed statement: plain commit does nothing; only the explicit partial commit commits', async () => {
    safeRun.mockResolvedValue(scriptReport(['done', 'failed', 'notRun']));
    await state().runSafeRun({ sql: SCRIPT });
    expect(state().safeRun?.phase).toBe('review');
    expect(state().safeRun?.report?.failedAt).toBe(2);

    await state().commitSafeRun();
    expect(safeRunFinish).not.toHaveBeenCalled();
    expect(state().safeRun?.phase).toBe('review');

    safeRunFinish.mockResolvedValue({ runId: 'run-1', outcome: 'committed', txnState: 'none' });
    await state().commitSafeRunPartial();
    expect(safeRunFinish).toHaveBeenCalledWith({ runId: 'run-1', action: 'commitPartial' });
    expect(state().safeRun?.phase).toBe('committed');
    // Only the statement that succeeded is shown as the tab's result.
    expect(state().tabs[0]?.queryResults).toHaveLength(1);
  });

  it('partial commit is refused for a script that did not fail', async () => {
    safeRun.mockResolvedValue(scriptReport(['done', 'done']));
    await state().runSafeRun({ sql: SCRIPT });
    await state().commitSafeRunPartial();
    expect(safeRunFinish).not.toHaveBeenCalled();
    expect(state().safeRun?.phase).toBe('review');
  });

  it('roll back all after a failure', async () => {
    safeRun.mockResolvedValue(scriptReport(['done', 'failed', 'notRun']));
    await state().runSafeRun({ sql: SCRIPT });
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

  it('statement 1 failing is a plain failure (nothing is held open)', async () => {
    safeRun.mockRejectedValue(new Error('Statement 1 failed: boom. Nothing was run.'));
    await state().runSafeRun({ sql: SCRIPT });
    expect(state().safeRun).toMatchObject({ phase: 'failed' });
    expect(state().safeRun?.error).toMatch(/Statement 1 failed/);
  });

  it('timeout rolls the whole script back and says so', async () => {
    safeRun.mockResolvedValue(scriptReport(['done', 'done']));
    await state().runSafeRun({ sql: SCRIPT });
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

  it('a lost connection during review is a roll back; during a COMMIT it is an unknown outcome', async () => {
    safeRun.mockResolvedValue(scriptReport(['done', 'done']));
    await state().runSafeRun({ sql: SCRIPT });
    useSession.setState({ connectionState: 'idle' } as never);
    expect(state().safeRun).toMatchObject({ phase: 'rolledBack', endReason: 'disconnect' });

    resetStore({ sql: SCRIPT });
    safeRun.mockResolvedValue(scriptReport(['done', 'done']));
    await state().runSafeRun({ sql: SCRIPT });
    safeRunFinish.mockReturnValue(new Promise(() => {}));
    void state().commitSafeRun();
    expect(state().safeRun?.phase).toBe('finishing');
    useSession.setState({ connectionState: 'idle' } as never);
    expect(state().safeRun).toMatchObject({ phase: 'failed', outcomeUnknown: true });
    expect(state().safeRun?.error).toMatch(/may or may not/);
  });

  it('a commit whose reply is lost is unknown, not "nothing saved"; a server refusal is not', async () => {
    safeRun.mockResolvedValue(scriptReport(['done', 'done']));
    await state().runSafeRun({ sql: SCRIPT });
    safeRunFinish.mockRejectedValue(new Error('Connection lost: terminated unexpectedly'));
    await state().commitSafeRun();
    expect(state().safeRun).toMatchObject({ phase: 'failed', outcomeUnknown: true });

    resetStore({ sql: SCRIPT });
    safeRun.mockResolvedValue(scriptReport(['done', 'done']));
    await state().runSafeRun({ sql: SCRIPT });
    safeRunFinish.mockRejectedValue(new Error('deferred constraint violated'));
    await state().commitSafeRun();
    expect(state().safeRun).toMatchObject({ phase: 'failed', outcomeUnknown: false });
    expect(state().safeRun?.error).toMatch(/Nothing was saved/);
  });

  it('the prod gate gets the whole script once and resumes into one Safe Run', async () => {
    resetStore({ tag: 'prod', sql: SCRIPT });
    useSession.setState((s) => ({
      settings: { ...s.settings, connectionAlwaysSafeRun: { c1: false } },
    }));
    await state().runSafeRun({ sql: SCRIPT });
    expect(safeRun).not.toHaveBeenCalled();
    expect(state().prodGate).toMatchObject({ sql: SCRIPT, safe: true });
    safeRun.mockResolvedValue(scriptReport(['done', 'done', 'done']));
    state().confirmProdGate();
    await vi.waitFor(() => expect(state().safeRun?.phase).toBe('review'));
    expect(safeRun).toHaveBeenCalledTimes(1);
  });

  it("a single statement keeps today's shape: no steps, undo does nothing", async () => {
    resetStore();
    safeRun.mockResolvedValue(report());
    await state().runSafeRun();
    expect(state().safeRun?.report?.steps).toBeUndefined();
    await state().undoSafeRun();
    expect(safeRunUndo).not.toHaveBeenCalled();
  });
});
