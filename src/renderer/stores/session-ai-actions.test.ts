import type { AiChatEvent, SafeRunReport } from '@shared/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryRun = vi.fn();
const sideband = vi.fn();
const introspect = vi.fn();
const safeRun = vi.fn();
const safeRunFinish = vi.fn();
const actionResult = vi.fn(async (_r: unknown) => undefined);
const aiCancel = vi.fn(async (_id: string) => undefined);
const aiChat = vi.fn(async (_r: unknown) => ({ accepted: true }));
const runReadOnly = vi.fn();
const queryCancel = vi.fn(async () => undefined);

vi.mock('@/lib/ipc', () => ({
  ipc: {
    query: {
      run: (...a: unknown[]) => queryRun(...a),
      sideband: (...a: unknown[]) => sideband(...a),
      cancel: () => queryCancel(),
      safeRun: (...a: unknown[]) => safeRun(...a),
      safeRunFinish: (...a: unknown[]) => safeRunFinish(...a),
    },
    conn: { introspect: (...a: unknown[]) => introspect(...a) },
    settings: { get: vi.fn(), set: vi.fn(async () => undefined) },
    vault: { list: vi.fn(async () => []) },
    history: { list: vi.fn(async () => []) },
    sql: { format: vi.fn() },
    ai: {
      chat: (r: unknown) => aiChat(r),
      cancel: (id: string) => aiCancel(id),
      actionResult: (r: unknown) => actionResult(r),
      runReadOnly: (sql: string) => runReadOnly(sql),
    },
  },
}));

import { restoreTableView } from '@/features/ai/table-view-apply';
import { useSession } from './session';
import { turnHistoryContent } from './session-ai';

const col = (name: string, dataType: string, ordinal: number) => ({
  schema: 'public',
  table: 'orders',
  name,
  dataType,
  ordinal,
  isPrimaryKey: name === 'id',
  isNullable: true,
  hasDefault: false,
});
const ORDER_COLUMNS = [
  col('id', 'integer', 1),
  col('status', 'text', 2),
  col('total', 'numeric', 3),
  col('created_at', 'timestamp with time zone', 4),
];
const SCHEMA = {
  schemas: [{ name: 'public' }],
  tables: [{ schema: 'public', name: 'orders', kind: 'table', rowCountEstimate: 5 }],
  columns: ORDER_COLUMNS,
  foreignKeys: [],
  routines: [],
  sequences: [],
  types: [],
  extensions: [],
};

const meta = (name: string) => ({ name, dataTypeID: 25, dataTypeName: 'text' });
const pageResult = {
  columns: [meta('id'), meta('total')],
  rows: [
    [1, 10],
    [2, 20],
  ],
  rowCount: 2,
  durationMs: 1,
};

function report(over: Partial<SafeRunReport> = {}): SafeRunReport {
  return {
    runId: 'run-1',
    kind: 'update',
    statement: "UPDATE orders SET status = 'x'",
    nested: false,
    affected: 3,
    affectedExact: true,
    estimateRows: 3,
    mode: 'diff',
    note: null,
    keyKind: 'pk',
    keyColumns: ['id'],
    beforeColumns: [],
    before: [],
    beforeCtids: null,
    beforeTotal: 3,
    afterColumns: [],
    after: [],
    afterCtids: null,
    afterTotal: 3,
    durationMs: 3,
    expiresAt: Date.now() + 300_000,
    timeoutSec: 300,
    txnState: 'active',
    ...over,
  } as SafeRunReport;
}

const state = () => useSession.getState();
function deferred() {
  let resolve: (v: unknown) => void = () => undefined;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
let counter = 0;

function startChat(opts: { readOnly?: boolean; engine?: string } = {}) {
  useSession.setState({
    connectionState: 'connected',
    connectionGen: 1,
    activeConfig: {
      id: 'c1',
      name: 'c',
      engine: opts.engine ?? 'postgres',
      readOnly: opts.readOnly,
    } as never,
    schema: SCHEMA as never,
    columnSchemas: new Set(['public']),
    tabs: [],
    activeTabId: null as never,
    prodGate: null,
    safeRun: null,
    aiActions: {},
    aiChatConnectionId: 'c1',
    aiRequestId: 'req1',
    aiPending: true,
    aiChat: [
      { id: 'u', role: 'user', content: 'show orders' },
      { id: 'a', role: 'assistant', content: '', streaming: true, parts: [] },
    ],
    settings: {
      ...state().settings,
      aiAutoApplyViews: false,
      connectionTags: {},
      connectionSafeMode: { c1: 'off' },
      connectionAlwaysSafeRun: {},
    },
  } as never);
}

function event(name: string, args: Record<string, unknown>): AiChatEvent {
  return {
    kind: 'action',
    requestId: 'req1',
    callId: `call_${counter++}`,
    name: name as never,
    args,
  };
}

const cards = () => Object.values(state().aiActions);
const lastResult = () => actionResult.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;

beforeEach(() => {
  queryRun.mockReset();
  sideband.mockReset();
  introspect.mockReset();
  safeRun.mockReset();
  safeRunFinish.mockReset();
  actionResult.mockClear();
  aiCancel.mockClear();
  runReadOnly.mockReset();
  queryCancel.mockClear();
  queryRun.mockResolvedValue(pageResult);
  sideband.mockResolvedValue({ columns: [meta('c')], rows: [[5]], rowCount: 1, durationMs: 1 });
  introspect.mockResolvedValue({ columns: ORDER_COLUMNS, foreignKeys: [] });
  startChat();
});

const SHOW = {
  schema: 'public',
  table: 'orders',
  columns: ['id', 'total'],
  sort: [{ column: 'created_at', direction: 'desc' }],
  filters: [{ column: 'status', op: '=', value: 'paid' }],
  limit: 10,
};

describe('agent action cards', () => {
  it('an action event shows a pending card and runs nothing', async () => {
    state().aiApplyEvent(event('show_table', SHOW));
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    const c = cards()[0]!;
    expect(c.status).toBe('pending');
    expect(c.view?.limit).toBe(10);
    // The card sits in the turn, in order.
    expect(state().aiChat[1]?.parts).toEqual([{ kind: 'action', actionId: c.id }]);
    expect(state().tabs).toHaveLength(0);
    expect(queryRun).not.toHaveBeenCalled();
    expect(actionResult).not.toHaveBeenCalled();
  });

  it('Approve applies the view, reports the first page, and Undo restores the old one', async () => {
    state().aiApplyEvent(event('show_table', SHOW));
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    const id = cards()[0]!.id;
    await state().aiApproveAction(id);

    const tab = state().tabs.find((t) => t.kind === 'table')!;
    expect(tab.tableName).toBe('orders');
    expect([...tab.hiddenColumns].sort()).toEqual(['created_at', 'status']);
    expect(tab.tableSort).toEqual([{ column: 'created_at', direction: 'desc' }]);
    expect(tab.filters).toHaveLength(1);
    expect(tab.filters[0]).toMatchObject({ column: 'status', op: '=', value: 'paid' });
    expect(tab.filters[0].id).toBeTruthy();
    expect(tab.pageSize).toBe(10);
    expect(tab.page).toBe(0);
    // The page query carries the view; the size setting is not persisted.
    const sqls = queryRun.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => /LIMIT 10/i.test(s) && /created_at/.test(s))).toBe(true);
    expect(state().settings.defaultPageSize).not.toBe(10);

    const card = state().aiActions[id]!;
    expect(card.status).toBe('applied');
    expect(card.snapshot).toBeTruthy();
    expect(lastResult()).toMatchObject({
      requestId: 'req1',
      outcome: 'applied',
      data: {
        columns: ['id', 'total'],
        rowCount: 2,
        rows: [
          [1, 10],
          [2, 20],
        ],
      },
    });

    await state().aiUndoAction(id);
    const back = state().tabs.find((t) => t.id === tab.id)!;
    expect(back.hiddenColumns.size).toBe(0);
    expect(back.tableSort).toEqual([]);
    expect(back.filters).toEqual([]);
    expect(back.pageSize).toBe(state().settings.defaultPageSize);
    expect(state().aiActions[id]?.undone).toBe(true);
  });

  it('applies to a table tab that is not the active one', async () => {
    state().openTable('public', 'orders', { newTab: true, preview: false });
    const tableTabId = state().activeTabId;
    await vi.waitFor(() => expect(queryRun).toHaveBeenCalled());
    state().addTab(); // an empty SQL tab becomes active
    expect(state().activeTabId).not.toBe(tableTabId);
    const { applyTableView } = await import('@/features/ai/table-view-apply');
    const snap = await applyTableView(tableTabId, {
      limit: 7,
      sort: [{ column: 'id', direction: 'asc' }],
    });
    const t = state().tabs.find((x) => x.id === tableTabId)!;
    expect(t.pageSize).toBe(7);
    expect(t.tableSort).toEqual([{ column: 'id', direction: 'asc' }]);
    await restoreTableView(tableTabId, snap);
    expect(state().tabs.find((x) => x.id === tableTabId)?.tableSort).toEqual([]);
  });

  it('answers a bad column at once: failed, no prompt, reason sent', async () => {
    state().aiApplyEvent(event('show_table', { ...SHOW, columns: ['id', 'totl'] }));
    await vi.waitFor(() => expect(actionResult).toHaveBeenCalled());
    const c = cards()[0]!;
    expect(c.status).toBe('failed');
    expect(c.note).toContain('"totl"');
    expect(c.note).toContain('total');
    expect(lastResult()).toMatchObject({ outcome: 'failed' });
    expect(state().tabs).toHaveLength(0);
  });

  it('answers an unknown table or invalid arguments at once', async () => {
    state().aiApplyEvent(event('show_table', { schema: 'public', table: 'ordres' }));
    await vi.waitFor(() => expect(actionResult).toHaveBeenCalledTimes(1));
    expect(cards()[0]?.note).toContain('orders');
    state().aiApplyEvent(event('run_query', { sql: 'delete from orders' }));
    await vi.waitFor(() => expect(actionResult).toHaveBeenCalledTimes(2));
    expect(lastResult()).toMatchObject({ outcome: 'failed' });
    expect(cards().every((c) => c.status === 'failed')).toBe(true);
    expect(queryRun).not.toHaveBeenCalled();
  });

  it('Reject sends the note and runs nothing', async () => {
    state().aiApplyEvent(event('propose_change', { sql: 'delete from orders', summary: 'wipe' }));
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    state().aiRejectAction(cards()[0]!.id, '  only paid orders ');
    expect(cards()[0]?.status).toBe('rejected');
    expect(lastResult()).toMatchObject({ outcome: 'rejected', note: 'only paid orders' });
    expect(queryRun).not.toHaveBeenCalled();
    expect(safeRun).not.toHaveBeenCalled();
    // A second click does nothing.
    await state().aiApproveAction(cards()[0]!.id);
    expect(queryRun).not.toHaveBeenCalled();
    expect(actionResult).toHaveBeenCalledTimes(1);
  });

  it('Stop cancels every pending card', async () => {
    state().aiApplyEvent(event('open_in_editor', { sql: 'select 1' }));
    state().aiApplyEvent(event('run_query', { sql: 'select 2' }));
    await vi.waitFor(() => expect(cards()).toHaveLength(2));
    await state().aiCancel();
    expect(cards().map((c) => c.status)).toEqual(['cancelled', 'cancelled']);
    expect(aiCancel).toHaveBeenCalledWith('req1');
    expect(state().aiPending).toBe(false);
    expect(state().tabs).toHaveLength(0);
  });

  it('a connection switch cancels pending cards and tells main', async () => {
    state().aiApplyEvent(event('open_in_editor', { sql: 'select 1' }));
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    useSession.setState({ activeConfig: { id: 'c2', name: 'other', engine: 'postgres' } as never });
    expect(cards()[0]?.status).toBe('cancelled');
    expect(lastResult()).toMatchObject({ outcome: 'cancelled' });
    // Approving after the fact does nothing.
    await state().aiApproveAction(cards()[0]!.id);
    expect(state().tabs).toHaveLength(0);
  });

  it('Clear cancels cards and empties the chat', async () => {
    state().aiApplyEvent(event('open_in_editor', { sql: 'select 1' }));
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    state().aiClear();
    expect(state().aiActions).toEqual({});
    expect(state().aiChat).toEqual([]);
  });

  it('ignores an action for a request that is no longer current', async () => {
    state().aiApplyEvent({ ...event('open_in_editor', { sql: 'select 1' }), requestId: 'old' });
    await flush();
    expect(cards()).toHaveLength(0);
    expect(actionResult).not.toHaveBeenCalled();
  });

  it('open_in_editor puts the SQL in a new tab, marked as AI, and does not run it', async () => {
    state().aiApplyEvent(event('open_in_editor', { sql: 'select 1' }));
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    await state().aiApproveAction(cards()[0]!.id);
    const tab = state().tabs.at(-1)!;
    expect(tab.sql).toBe('select 1');
    expect(queryRun).not.toHaveBeenCalled();
    expect(lastResult()).toMatchObject({ outcome: 'applied' });
    const { isAiApplied } = await import('@/lib/ai-applied');
    expect(isAiApplied(tab.id, 'select 1')).toBe(true);
  });

  it('never overwrites a tab that has SQL', async () => {
    state().openSqlInNewTab('select 99', { title: 'mine' });
    const mine = state().activeTabId;
    state().aiApplyEvent(event('open_in_editor', { sql: 'select 1' }));
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    await state().aiApproveAction(cards()[0]!.id);
    expect(state().tabs.find((t) => t.id === mine)?.sql).toBe('select 99');
    expect(state().tabs).toHaveLength(2);
  });

  it('run_query runs in a read-only session and shows the result in a new tab', async () => {
    runReadOnly.mockResolvedValue({
      columns: [meta('n')],
      rows: [[1n], [2n]],
      rowCount: 2,
      durationMs: 1,
    });
    state().aiApplyEvent(event('run_query', { sql: 'select n from t', title: 'counts' }));
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    expect(cards()[0]?.sandboxed).toBe(true);
    await state().aiApproveAction(cards()[0]!.id);
    // Never the primary connection's autocommit.
    expect(queryRun).not.toHaveBeenCalled();
    expect(runReadOnly).toHaveBeenCalledWith('select n from t');
    const tab = state().tabs.at(-1)!;
    expect(tab.sql).toBe('select n from t');
    expect(tab.queryResult?.rowCount).toBe(2);
    expect(tab.queryRunState).toBe('idle');
    expect(cards()[0]?.status).toBe('applied');
    // bigint cells are made JSON-safe before they leave the renderer.
    expect(lastResult()).toMatchObject({
      outcome: 'applied',
      data: { columns: ['n'], rows: [['1'], ['2']], rowCount: 2 },
    });
  });

  it('run_query reports a database error as failed, keeping the raw text for main to gate (P0-1)', async () => {
    runReadOnly.mockRejectedValue(new Error("Duplicate entry 'alice@corp.com' for key 'k'"));
    state().aiApplyEvent(event('run_query', { sql: 'select * from t' }));
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    await state().aiApproveAction(cards()[0]!.id);
    expect(cards()[0]?.status).toBe('failed');
    expect(state().tabs.at(-1)?.queryError).toContain('Duplicate');
    expect(lastResult()).toMatchObject({
      outcome: 'failed',
      dbError: "Duplicate entry 'alice@corp.com' for key 'k'",
    });
  });

  it('an engine without a read-only session says so and runs through the normal path (P1-1)', async () => {
    startChat({ engine: 'duckdb' });
    queryRun.mockResolvedValue({ columns: [meta('n')], rows: [[1]], rowCount: 1, durationMs: 1 });
    state().aiApplyEvent(event('run_query', { sql: 'select 1' }));
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    expect(cards()[0]?.sandboxed).toBe(false);
    await state().aiApproveAction(cards()[0]!.id);
    expect(runReadOnly).not.toHaveBeenCalled();
    expect(queryRun).toHaveBeenCalledTimes(1);
    expect(cards()[0]?.status).toBe('applied');
  });

  it('run_query waits for the confirmation; declining reports rejected and runs nothing', async () => {
    startChat({ engine: 'duckdb' });
    useSession.setState({
      settings: { ...state().settings, connectionSafeMode: { c1: 'confirm-all' } },
    } as never);
    state().aiApplyEvent(event('run_query', { sql: 'select 1' }));
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    void state().aiApproveAction(cards()[0]!.id);
    await vi.waitFor(() => expect(state().prodGate).not.toBeNull());
    expect(cards()[0]?.status).toBe('running');
    expect(actionResult).not.toHaveBeenCalled();
    state().cancelProdGate();
    await vi.waitFor(() => expect(cards()[0]?.status).toBe('rejected'));
    expect(queryRun).not.toHaveBeenCalled();
    expect(lastResult()).toMatchObject({ outcome: 'rejected' });
  });

  it('run_query waits for the confirmation; confirming runs it and reports the result', async () => {
    startChat({ engine: 'duckdb' });
    useSession.setState({
      settings: { ...state().settings, connectionSafeMode: { c1: 'confirm-all' } },
    } as never);
    state().aiApplyEvent(event('run_query', { sql: 'select 1' }));
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    void state().aiApproveAction(cards()[0]!.id);
    await vi.waitFor(() => expect(state().prodGate).not.toBeNull());
    state().confirmProdGate();
    await vi.waitFor(() => expect(cards()[0]?.status).toBe('applied'));
    expect(queryRun).toHaveBeenCalledTimes(1);
  });

  it('propose_change on a read-only connection fails without a prompt', async () => {
    startChat({ readOnly: true });
    state().aiApplyEvent(
      event('propose_change', { sql: 'update orders set status = 1', summary: 's' }),
    );
    await vi.waitFor(() => expect(actionResult).toHaveBeenCalled());
    expect(cards()[0]?.status).toBe('failed');
    expect(cards()[0]?.note).toMatch(/read-only/);
    expect(safeRun).not.toHaveBeenCalled();
  });

  it('propose_change fails without a prompt while a Safe Run is pending', async () => {
    state().openSqlInNewTab('select 1');
    const open = state().activeTabId;
    useSession.setState({
      safeRun: {
        tabId: open,
        sql: '',
        phase: 'review',
        report: null,
        error: null,
        endReason: null,
        connectionGen: 1,
        token: 99,
        nudge: 0,
      },
    } as never);
    state().aiApplyEvent(
      event('propose_change', { sql: 'update orders set status = 1', summary: 's' }),
    );
    await vi.waitFor(() => expect(actionResult).toHaveBeenCalled());
    expect(cards()[0]?.status).toBe('failed');
  });

  it('propose_change on Postgres previews with Safe Run; the card follows it to commit', async () => {
    safeRun.mockResolvedValue(report());
    safeRunFinish.mockResolvedValue({ outcome: 'committed', txnState: 'none' });
    state().aiApplyEvent(
      event('propose_change', { sql: "update orders set status = 'x'", summary: 'mark x' }),
    );
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    expect(cards()[0]?.mode).toBe('preview');
    expect(cards()[0]?.status).toBe('pending');
    expect(safeRun).not.toHaveBeenCalled();

    await state().aiApproveAction(cards()[0]!.id);
    expect(safeRun).toHaveBeenCalledTimes(1);
    expect(state().safeRun?.phase).toBe('review');
    expect(cards()[0]?.status).toBe('running');
    // Nothing is committed and the model has not been told it worked.
    expect(safeRunFinish).not.toHaveBeenCalled();
    expect(actionResult).not.toHaveBeenCalled();

    await state().commitSafeRun();
    await vi.waitFor(() => expect(cards()[0]?.status).toBe('applied'));
    expect(lastResult()).toMatchObject({ outcome: 'applied' });
    expect(String(lastResult()?.note)).toContain('3 rows');
  });

  it('a rolled back preview is reported as rejected', async () => {
    safeRun.mockResolvedValue(report());
    safeRunFinish.mockResolvedValue({ outcome: 'rolledBack', txnState: 'none' });
    state().aiApplyEvent(
      event('propose_change', { sql: "update orders set status = 'x'", summary: 's' }),
    );
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    await state().aiApproveAction(cards()[0]!.id);
    await state().rollbackSafeRun();
    await vi.waitFor(() => expect(cards()[0]?.status).toBe('rejected'));
    expect(lastResult()).toMatchObject({ outcome: 'rejected' });
    expect(String(lastResult()?.note)).toMatch(/rolled back/);
  });

  it('closing the Safe Run panel mid-review is reported as rejected', async () => {
    safeRun.mockResolvedValue(report());
    safeRunFinish.mockResolvedValue({ outcome: 'rolledBack', txnState: 'none' });
    state().aiApplyEvent(
      event('propose_change', { sql: "update orders set status = 'x'", summary: 's' }),
    );
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    await state().aiApproveAction(cards()[0]!.id);
    expect(state().safeRun?.phase).toBe('review');
    state().dismissSafeRun();
    await vi.waitFor(() => expect(cards()[0]?.status).toBe('rejected'));
    expect(String(lastResult()?.note)).toMatch(/closed the preview/);
  });

  it('a preview that needs the prod confirmation waits for it; declining is rejected', async () => {
    useSession.setState({
      settings: {
        ...state().settings,
        connectionTags: { c1: 'prod' },
        connectionSafeMode: { c1: 'off' },
      },
    } as never);
    state().aiApplyEvent(event('propose_change', { sql: 'delete from orders', summary: 'wipe' }));
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    await state().aiApproveAction(cards()[0]!.id);
    expect(state().prodGate).not.toBeNull();
    expect(safeRun).not.toHaveBeenCalled();
    expect(cards()[0]?.status).toBe('running');
    state().cancelProdGate();
    await vi.waitFor(() => expect(cards()[0]?.status).toBe('rejected'));
    expect(safeRun).not.toHaveBeenCalled();
  });

  it('confirming the prod gate starts the preview and the card follows it', async () => {
    safeRun.mockResolvedValue(report());
    useSession.setState({
      settings: {
        ...state().settings,
        connectionTags: { c1: 'prod' },
        connectionSafeMode: { c1: 'off' },
      },
    } as never);
    state().aiApplyEvent(event('propose_change', { sql: 'delete from orders', summary: 'wipe' }));
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    await state().aiApproveAction(cards()[0]!.id);
    state().confirmProdGate();
    await vi.waitFor(() => expect(state().safeRun?.phase).toBe('review'));
    await new Promise((r) => setTimeout(r, 10));
    expect(cards()[0]?.status).toBe('running');
    expect(actionResult).not.toHaveBeenCalled();
  });

  it('a failed preview is reported as failed', async () => {
    safeRun.mockRejectedValue(new Error('column "nope" does not exist'));
    state().aiApplyEvent(
      event('propose_change', { sql: 'update orders set nope = 1', summary: 's' }),
    );
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    await state().aiApproveAction(cards()[0]!.id);
    await vi.waitFor(() => expect(cards()[0]?.status).toBe('failed'));
    expect(String(lastResult()?.note)).toContain('nope');
  });

  it('Stop rolls back a preview the card started', async () => {
    safeRun.mockResolvedValue(report());
    safeRunFinish.mockResolvedValue({ outcome: 'rolledBack', txnState: 'none' });
    state().aiApplyEvent(
      event('propose_change', { sql: "update orders set status = 'x'", summary: 's' }),
    );
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    await state().aiApproveAction(cards()[0]!.id);
    await state().aiCancel();
    expect(cards()[0]?.status).toBe('cancelled');
    await vi.waitFor(() =>
      expect(safeRunFinish).toHaveBeenCalledWith({ runId: 'run-1', action: 'rollback' }),
    );
  });

  it('propose_change without a preview says so plainly and runs through the normal path', async () => {
    queryRun.mockResolvedValue({
      columns: [],
      rows: [],
      rowCount: 0,
      durationMs: 1,
      command: 'CREATE INDEX',
    });
    state().aiApplyEvent(
      event('propose_change', { sql: 'create index i on orders (id)', summary: 'index' }),
    );
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    expect(cards()[0]?.mode).toBe('run');
    expect(safeRun).not.toHaveBeenCalled();
    await state().aiApproveAction(cards()[0]!.id);
    expect(queryRun).toHaveBeenCalledTimes(1);
    expect(cards()[0]?.status).toBe('applied');
    expect(safeRun).not.toHaveBeenCalled();
  });

  it('non-Postgres engines have no preview either', async () => {
    startChat({ engine: 'sqlite' });
    state().aiApplyEvent(
      event('propose_change', { sql: 'update orders set status = 1', summary: 's' }),
    );
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    expect(cards()[0]?.mode).toBe('run');
  });

  it('"apply view changes without asking" applies show_table at once, never anything else', async () => {
    useSession.setState({ settings: { ...state().settings, aiAutoApplyViews: true } } as never);
    state().aiApplyEvent(event('show_table', SHOW));
    await vi.waitFor(() => expect(cards()[0]?.status).toBe('applied'));
    expect(cards()[0]?.snapshot).toBeTruthy();
    state().aiApplyEvent(event('propose_change', { sql: 'delete from orders', summary: 'x' }));
    state().aiApplyEvent(event('run_query', { sql: 'select 1' }));
    state().aiApplyEvent(event('open_in_editor', { sql: 'select 1' }));
    await vi.waitFor(() => expect(cards()).toHaveLength(4));
    expect(
      cards()
        .slice(1)
        .map((c) => c.status),
    ).toEqual(['pending', 'pending', 'pending']);
  });
});

describe('streaming parts and history', () => {
  it('interleaves text and cards in order', async () => {
    state().aiApplyEvent({ kind: 'delta', requestId: 'req1', text: 'Opening' });
    state().aiApplyEvent({ kind: 'delta', requestId: 'req1', text: ' it.' });
    state().aiApplyEvent(event('open_in_editor', { sql: 'select 1' }));
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    state().aiApplyEvent({ kind: 'delta', requestId: 'req1', text: '\n' });
    state().aiApplyEvent({ kind: 'delta', requestId: 'req1', text: 'Done.' });
    const turn = state().aiChat[1]!;
    expect(turn.parts).toEqual([
      { kind: 'text', text: 'Opening it.' },
      { kind: 'action', actionId: cards()[0]!.id },
      { kind: 'text', text: 'Done.' },
    ]);
    expect(turn.content).toBe('Opening it.\nDone.');
  });

  it('sends later turns with one line per action', () => {
    const actions = {
      a1: {
        id: 'a1',
        requestId: 'r',
        callId: 'c1',
        name: 'show_table',
        action: { name: 'show_table', schema: 'public', table: 'orders', rawView: {} },
        status: 'applied',
      },
      a2: {
        id: 'a2',
        requestId: 'r',
        callId: 'c2',
        name: 'propose_change',
        action: { name: 'propose_change', sql: 'delete from orders', summary: 's' },
        status: 'rejected',
        note: 'only paid orders',
      },
    } as never;
    const turn = {
      id: 't',
      role: 'assistant',
      content: 'x',
      parts: [
        { kind: 'text', text: 'Here you go.' },
        { kind: 'action', actionId: 'a1' },
        { kind: 'action', actionId: 'a2' },
      ],
    } as never;
    expect(turnHistoryContent(turn, actions)).toBe(
      'Here you go.\n[show_table public.orders: applied]\n[propose_change: rejected — "only paid orders"]',
    );
  });

  it('aiAsk sends the agent flag, the schema for any SQL engine and the tab context', async () => {
    startChat({ engine: 'sqlite' });
    useSession.setState({
      aiPending: false,
      aiRequestId: null,
      aiChat: [],
      aiChatConnectionId: null,
    } as never);
    state().openTable('public', 'orders', { newTab: true, preview: false });
    await state().aiAsk('show orders');
    const req = aiChat.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(req.agent).toBe(true);
    expect(req.engine).toBe('sqlite');
    expect(req.schema).toBeTruthy();
    expect(String(req.context)).toContain('Current tab: table public.orders');
  });

  it('aiAsk on Redis stays a plain chat', async () => {
    startChat({ engine: 'redis' });
    useSession.setState({
      aiPending: false,
      aiRequestId: null,
      aiChat: [],
      aiChatConnectionId: null,
    } as never);
    await state().aiAsk('what keys');
    const req = aiChat.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(req.agent).toBeUndefined();
    expect(req.context).toBeUndefined();
    expect(req.schema).toBeNull();
  });
});

describe('review fixes (store)', () => {
  const tableTab = async () => {
    state().openTable('public', 'orders', { newTab: true, preview: false });
    await vi.waitFor(() => expect(queryRun).toHaveBeenCalled());
    return state().activeTabId;
  };

  it('P0-2: a hidden-value placeholder keeps the filter the user has, and cannot invent one', async () => {
    const id = await tableTab();
    useSession.setState((st) => ({
      tabs: st.tabs.map((t) =>
        t.id === id
          ? { ...t, filters: [{ id: 'f1', column: 'status', op: '=', value: 'paid@corp.com' }] }
          : t,
      ),
    }));
    state().aiApplyEvent(
      event('show_table', {
        schema: 'public',
        table: 'orders',
        filters: [{ column: 'status', op: '=', value: '<hidden>' }],
        limit: 5,
      }),
    );
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    expect(cards()[0]?.view?.filters).toEqual([
      { column: 'status', op: '=', value: 'paid@corp.com' },
    ]);
    state().aiApplyEvent(
      event('show_table', {
        schema: 'public',
        table: 'orders',
        filters: [{ column: 'total', op: '>', value: '<hidden>' }],
      }),
    );
    await vi.waitFor(() => expect(cards()).toHaveLength(2));
    expect(cards()[1]?.status).toBe('failed');
    expect(cards()[1]?.note).toContain('placeholder');
  });

  it('P0-2: the agent context hides filter values until row data is opted in', async () => {
    const id = await tableTab();
    useSession.setState((st) => ({
      tabs: st.tabs.map((t) =>
        t.id === id
          ? { ...t, filters: [{ id: 'f1', column: 'status', op: '=', value: 'secret-x' }] }
          : t,
      ),
    }));
    useSession.setState({
      aiPending: false,
      aiRequestId: null,
      aiChat: [],
      aiChatConnectionId: null,
    } as never);
    await state().aiAsk('hi');
    const req = aiChat.mock.calls.at(-1)?.[0] as { context?: string };
    expect(req.context).toContain('status = <hidden>');
    expect(req.context).not.toContain('secret-x');
    useSession.setState({
      aiPending: false,
      aiRequestId: null,
      aiChat: [],
      aiChatConnectionId: null,
      settings: { ...state().settings, connectionAiRowData: { c1: true } },
    } as never);
    await state().aiAsk('hi');
    expect((aiChat.mock.calls.at(-1)?.[0] as { context?: string }).context).toContain('secret-x');
  });

  it('P1-3: without schema sharing, failures do not list names', async () => {
    useSession.setState({ settings: { ...state().settings, aiSendSchema: false } } as never);
    state().aiApplyEvent(event('show_table', { schema: 'public', table: 'ordres' }));
    state().aiApplyEvent(
      event('show_table', { schema: 'public', table: 'orders', columns: ['totl'] }),
    );
    await vi.waitFor(() => expect(cards()).toHaveLength(2));
    for (const c of cards()) {
      expect(c.status).toBe('failed');
      expect(c.note).not.toMatch(/orders|total|created_at|Close names|Available/);
    }
    expect(cards()[1]?.note).toContain('"totl"');
  });

  it('P2-2: an exception while handling an action answers failed instead of hanging', async () => {
    useSession.setState({
      schema: {
        get tables(): never {
          throw new Error('boom');
        },
      } as never,
    });
    state().aiApplyEvent(event('show_table', { schema: 'public', table: 'orders' }));
    await vi.waitFor(() => expect(actionResult).toHaveBeenCalled());
    expect(lastResult()).toMatchObject({ outcome: 'failed' });
  });

  it('P1-2: Stop while a write runs says the statement may have run, and cancels it', async () => {
    startChat({ engine: 'sqlite' });
    const gate = deferred();
    queryRun.mockReturnValue(gate.promise);
    state().aiApplyEvent(
      event('propose_change', { sql: 'update orders set status = 1', summary: 's' }),
    );
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    void state().aiApproveAction(cards()[0]!.id);
    await vi.waitFor(() => expect(queryRun).toHaveBeenCalled());
    await state().aiCancel();
    expect(cards()[0]?.status).toBe('cancelled');
    expect(cards()[0]?.note).toBe('Stopped; the statement may have run. Check the data.');
    expect(queryCancel).toHaveBeenCalled();
    gate.resolve({ columns: [], rows: [], rowCount: 1, durationMs: 1 });
  });

  it('P1-2: a connection change reports that to the model, not "nothing ran"', async () => {
    startChat({ engine: 'sqlite' });
    queryRun.mockReturnValue(new Promise(() => undefined));
    state().aiApplyEvent(
      event('propose_change', { sql: 'update orders set status = 1', summary: 's' }),
    );
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    void state().aiApproveAction(cards()[0]!.id);
    await vi.waitFor(() => expect(queryRun).toHaveBeenCalled());
    useSession.setState({ activeConfig: { id: 'c2', name: 'x', engine: 'sqlite' } as never });
    expect(String(lastResult()?.note)).toContain('may have run');
    expect(String(lastResult()?.note)).not.toMatch(/nothing ran/i);
  });

  it('P1-2: Stop closes an open prod confirmation so confirming later cannot run the write', async () => {
    startChat({ engine: 'sqlite' });
    useSession.setState({
      settings: {
        ...state().settings,
        connectionTags: { c1: 'prod' },
        connectionSafeMode: { c1: 'off' },
      },
    } as never);
    state().aiApplyEvent(event('propose_change', { sql: 'delete from orders', summary: 's' }));
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    void state().aiApproveAction(cards()[0]!.id);
    await vi.waitFor(() => expect(state().prodGate).not.toBeNull());
    await state().aiCancel();
    expect(state().prodGate).toBeNull();
    expect(cards()[0]?.status).toBe('cancelled');
    expect(cards()[0]?.note).toMatch(/before the statement ran/);
    state().confirmProdGate();
    await new Promise((r) => setTimeout(r, 10));
    expect(queryRun).not.toHaveBeenCalled();
  });

  it('P1-2: a commit already on its way is not reported as cancelled', async () => {
    safeRun.mockResolvedValue(report());
    const fin = deferred();
    safeRunFinish.mockReturnValue(fin.promise);
    state().aiApplyEvent(
      event('propose_change', { sql: "update orders set status = 'x'", summary: 's' }),
    );
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    await state().aiApproveAction(cards()[0]!.id);
    void state().commitSafeRun();
    await vi.waitFor(() => expect(state().safeRun?.phase).toBe('finishing'));
    await state().aiCancel();
    expect(cards()[0]?.status).toBe('running');
    fin.resolve({ outcome: 'committed', txnState: 'none' });
    await vi.waitFor(() => expect(cards()[0]?.status).toBe('applied'));
  });

  it('P2-7: a write that ran inside an open transaction is not reported as committed', async () => {
    startChat({ engine: 'sqlite' });
    queryRun.mockImplementation(async () => {
      useSession.setState({ txnState: 'active' });
      return { columns: [], rows: [], rowCount: 2, durationMs: 1, txnState: 'active' };
    });
    state().aiApplyEvent(
      event('propose_change', { sql: 'update orders set status = 1', summary: 's' }),
    );
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    await state().aiApproveAction(cards()[0]!.id);
    expect(String(cards()[0]?.note)).toContain('NOT committed');
    expect(String(lastResult()?.note)).toContain('NOT committed');
  });

  it('P2-8: Stop during a running show_table puts the old view back', async () => {
    const slow = deferred();
    state().aiApplyEvent(event('show_table', SHOW));
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    queryRun.mockReturnValue(slow.promise);
    void state().aiApproveAction(cards()[0]!.id);
    await vi.waitFor(() =>
      expect(state().tabs.some((t) => t.kind === 'table' && t.pageSize === 10)).toBe(true),
    );
    await state().aiCancel();
    slow.resolve(pageResult);
    await vi.waitFor(() => {
      const t = state().tabs.find((x) => x.kind === 'table')!;
      expect(t.pageSize).toBe(state().settings.defaultPageSize);
      expect(t.filters).toEqual([]);
    });
    expect(cards()[0]?.status).toBe('cancelled');
  });

  it("P2-4: columns hidden by a view are not saved as the user's column state", async () => {
    state().aiApplyEvent(event('show_table', SHOW));
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    await state().aiApproveAction(cards()[0]!.id);
    const tab = state().tabs.find((t) => t.kind === 'table')!;
    expect([...tab.agentHiddenColumns].sort()).toEqual(['created_at', 'status']);
    await state().toggleColumnHidden('total');
    const saved = Object.values(state().settings.tableColumnState ?? {})[0] as { hidden: string[] };
    expect(saved.hidden).toEqual(['total']);
  });

  it('P2-5: filters the user switched off survive a view change', async () => {
    const id = await tableTab();
    useSession.setState((st) => ({
      tabs: st.tabs.map((t) =>
        t.id === id
          ? {
              ...t,
              filters: [{ id: 'off1', column: 'total', op: '>', value: '5', enabled: false }],
            }
          : t,
      ),
    }));
    state().aiApplyEvent(event('show_table', SHOW));
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    await state().aiApproveAction(cards()[0]!.id);
    const filters = state().tabs.find((t) => t.id === id)!.filters;
    expect(filters.map((f: { column: string }) => f.column)).toEqual(['status', 'total']);
    expect(filters[1]).toMatchObject({ id: 'off1', enabled: false });
  });
});
