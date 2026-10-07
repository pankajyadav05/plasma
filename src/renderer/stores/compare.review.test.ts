import { beforeEach, describe, expect, it, vi } from 'vitest';

const compareRun = vi.fn();
const compareCancel = vi.fn(async (_runId: string) => undefined);
const cancelAux = vi.fn(async () => undefined);

vi.mock('@/lib/ipc', () => ({
  ipc: {
    compare: {
      run: (...a: unknown[]) => compareRun(...a),
      cancel: (runId: string) => compareCancel(runId),
    },
    export: { save: vi.fn() },
    query: { run: vi.fn(), cancel: vi.fn(async () => 'sent'), cancelAux: () => cancelAux() },
    sql: { format: vi.fn() },
    conn: { test: vi.fn(), connect: vi.fn(), disconnect: vi.fn() },
    schema: { introspect: vi.fn() },
    settings: { get: vi.fn(), set: vi.fn(async () => ({})) },
    history: { list: vi.fn(async () => []), clear: vi.fn() },
    txn: { begin: vi.fn(), commit: vi.fn(), rollback: vi.fn() },
    ai: { ask: vi.fn(), cancel: vi.fn() },
  },
}));

import { useCompare } from './compare';
import { useSession } from './session';

const res = (rows: unknown[][]) => ({
  columns: [
    { name: 'id', dataTypeID: 23, dataTypeName: 'int4' },
    { name: 'v', dataTypeID: 25, dataTypeName: 'text' },
  ],
  rows,
  rowCount: rows.length,
  durationMs: 1,
  command: 'SELECT',
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('review fixes: compare store', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    compareRun.mockReset();
    compareCancel.mockClear();
    cancelAux.mockClear();
    useCompare.setState({ sessions: {} });
    useSession.setState({
      activeConfig: { id: 'stg', name: 'staging', engine: 'postgres' } as never,
      savedConnections: [
        { id: 'stg', name: 'staging', engine: 'postgres' },
        { id: 'prod', name: 'production', engine: 'postgres' },
      ] as never,
    });
  });

  it('P2-5: swapping while a side is loading re-runs it on its new side instead of sticking on loading', async () => {
    const slow = deferred<ReturnType<typeof res>>();
    compareRun.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(res([[1, 'x']]));
    const id = useCompare.getState().open();
    useCompare
      .getState()
      .setSide(id, 'b', { kind: 'query', connectionId: 'prod', sql: 'select 1' });
    expect(useCompare.getState().sessions[id]!.b.status).toBe('loading');
    useCompare.getState().swap(id);
    await new Promise((r) => setTimeout(r, 30));
    const s = useCompare.getState().sessions[id]!;
    expect(s.a.status).toBe('ready'); // the moved query finished on side A
    expect(s.a.connectionName).toBe('production');
    expect(s.b.status).toBe('empty');
    // The first request was interrupted on the server, and its late answer is ignored.
    expect(compareCancel).toHaveBeenCalledTimes(1);
    slow.resolve(res([[9, 'late']]));
    await new Promise((r) => setTimeout(r, 30));
    expect(useCompare.getState().sessions[id]!.a.source?.rows).toEqual([[1, 'x']]);
  });

  it('P2-8: Stop waiting interrupts a run on another connection by id; on the active one only aux', async () => {
    compareRun.mockReturnValue(new Promise(() => {}));
    const id = useCompare.getState().open();
    useCompare
      .getState()
      .setSide(id, 'a', { kind: 'query', connectionId: 'prod', sql: 'select 1' });
    const runId = compareRun.mock.calls[0]![0].runId as string;
    expect(runId).toBeTruthy();
    useCompare.getState().clearSide(id, 'a');
    expect(compareCancel).toHaveBeenCalledWith(runId);

    useCompare.getState().setSide(id, 'b', { kind: 'query', connectionId: null, sql: 'select 2' });
    useCompare.getState().clearSide(id, 'b');
    expect(cancelAux).toHaveBeenCalledTimes(1);
    expect(compareCancel).toHaveBeenCalledTimes(1);
  });

  it('P1-5: a join with two id columns says they are paired by position and sees the change', async () => {
    const dup = (b: number) => ({
      columns: [
        { name: 'id', dataTypeID: 23, dataTypeName: 'int4' },
        { name: 'name', dataTypeID: 25, dataTypeName: 'text' },
        { name: 'id', dataTypeID: 23, dataTypeName: 'int4' },
      ],
      rows: [[1, 'a', b]],
      rowCount: 1,
      durationMs: 1,
      command: 'SELECT',
    });
    compareRun.mockResolvedValueOnce(dup(1)).mockResolvedValueOnce(dup(9));
    const id = useCompare
      .getState()
      .open(
        { kind: 'query', connectionId: null, sql: 'select a.id, a.name, b.id from a join b' },
        { kind: 'query', connectionId: 'prod', sql: 'select a.id, a.name, b.id from a join b' },
      );
    for (let i = 0; i < 60 && useCompare.getState().sessions[id]!.phase !== 'done'; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const s = useCompare.getState().sessions[id]!;
    expect(s.result?.pairedByPosition).toEqual(['id']);
    expect(s.result?.onlyRight).toEqual([]);
    expect((s.result?.summary.changed ?? 0) + (s.result?.summary.removed ?? 0)).toBeGreaterThan(0);
  });
});
