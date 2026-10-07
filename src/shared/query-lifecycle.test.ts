import { describe, expect, it } from 'vitest';
import {
  CANCELLED_NOTE,
  IDLE_LIFECYCLE,
  type QueryLifecycle,
  cancelIsStuck,
  classifyFailure,
  formatElapsed,
  lifecycleFromLegacyPatch,
  reduceLifecycle,
  writeTarget,
} from './query-lifecycle';

const running = (t = 1000): QueryLifecycle => ({ phase: 'running', since: t, startedAt: t });

describe('reduceLifecycle', () => {
  it('walks queued → running → succeeded with the elapsed time', () => {
    let l = reduceLifecycle(IDLE_LIFECYCLE, { type: 'queue', now: 1000 });
    expect(l.phase).toBe('queued');
    l = reduceLifecycle(l, { type: 'begin', now: 1500 });
    expect(l).toMatchObject({ phase: 'running', startedAt: 1500 });
    l = reduceLifecycle(l, { type: 'succeed', now: 2700 });
    expect(l).toMatchObject({ phase: 'succeeded', elapsedMs: 1200 });
  });

  it('cancel on a running query becomes cancelled when the engine reports its cancel error', () => {
    let l = reduceLifecycle(running(), { type: 'cancel', now: 2000 });
    expect(l.phase).toBe('cancelling');
    expect(l.startedAt).toBe(1000);
    l = reduceLifecycle(l, {
      type: 'fail',
      now: 2100,
      message: 'canceling statement due to user request',
    });
    expect(l).toMatchObject({ phase: 'cancelled', message: CANCELLED_NOTE, elapsedMs: 1100 });
  });

  it('cancel after finish is ignored', () => {
    const done = reduceLifecycle(running(), { type: 'succeed', now: 1500 });
    expect(reduceLifecycle(done, { type: 'cancel', now: 1600 })).toBe(done);
    const failed = reduceLifecycle(running(), { type: 'fail', now: 1500, message: 'boom' });
    expect(reduceLifecycle(failed, { type: 'cancel', now: 1600 })).toBe(failed);
  });

  it('finish after cancel: the result wins, flagged as finished before the cancel', () => {
    const l = reduceLifecycle(reduceLifecycle(running(), { type: 'cancel', now: 1100 }), {
      type: 'succeed',
      now: 1200,
    });
    expect(l).toMatchObject({ phase: 'succeeded', finishedBeforeCancel: true });
  });

  it('a late result never reopens a settled run', () => {
    const cancelled = reduceLifecycle(reduceLifecycle(running(), { type: 'cancel', now: 1100 }), {
      type: 'fail',
      now: 1200,
      message: 'cancelled',
    });
    expect(reduceLifecycle(cancelled, { type: 'succeed', now: 1300 })).toBe(cancelled);
    expect(reduceLifecycle(cancelled, { type: 'fail', now: 1300, message: 'x' })).toBe(cancelled);
  });

  it('nothing to cancel returns to running', () => {
    const c = reduceLifecycle(running(), { type: 'cancel', now: 1100 });
    const back = reduceLifecycle(c, { type: 'cancelNothing', now: 1150 });
    expect(back).toMatchObject({ phase: 'running', since: 1000 });
  });

  it('cannot cancel a queued run', () => {
    const q = reduceLifecycle(IDLE_LIFECYCLE, { type: 'queue', now: 1 });
    expect(reduceLifecycle(q, { type: 'cancel', now: 2 })).toBe(q);
  });

  it('a failed cancel keeps cancelling and records why', () => {
    const c = reduceLifecycle(running(), { type: 'cancel', now: 1100 });
    const f = reduceLifecycle(c, { type: 'cancelFailed', now: 1200, message: 'no answer' });
    expect(f).toMatchObject({ phase: 'cancelling', cancelNote: 'no answer' });
  });

  it('cancelling becomes stuck after 5s', () => {
    const c = reduceLifecycle(running(), { type: 'cancel', now: 10_000 });
    expect(cancelIsStuck(c, 14_999)).toBe(false);
    expect(cancelIsStuck(c, 15_000)).toBe(true);
    expect(cancelIsStuck(running(), 99_999)).toBe(false);
  });

  it('reset returns to idle', () => {
    expect(reduceLifecycle(running(), { type: 'reset' })).toBe(IDLE_LIFECYCLE);
  });
});

describe('classifyFailure', () => {
  it('a plain SQL error is failed', () => {
    expect(classifyFailure('syntax error at or near "x"', {})).toMatchObject({ phase: 'failed' });
  });

  it('a lost connection during a read is disconnected', () => {
    const c = classifyFailure('Connection terminated unexpectedly', { isWrite: false });
    expect(c.phase).toBe('disconnected');
  });

  it('a lost connection during a write is outcome unknown', () => {
    const c = classifyFailure('Connection terminated unexpectedly', { isWrite: true });
    expect(c.phase).toBe('unknown');
    expect(c.message).toMatch(/may or may not have been applied/);
  });

  it('main refusing to replay a write is outcome unknown', () => {
    const c = classifyFailure(
      'Connection lost — the statement was not re-run; it may or may not have been applied. Reconnected: check the data before trying again. (x)',
      {},
    );
    expect(c.phase).toBe('unknown');
  });

  it('a rolled back transaction is definite, not unknown', () => {
    const c = classifyFailure(
      'Connection lost during an open transaction — the transaction was rolled back by the server and nothing was re-run.',
      { isWrite: true },
    );
    expect(c.phase).toBe('disconnected');
  });

  it('a connection lost while cancelling is disconnected, not cancelled', () => {
    expect(
      classifyFailure('connection terminated', { wasCancelling: true, isWrite: false }).phase,
    ).toBe('disconnected');
  });

  it('a cancel error without a cancel request stays failed', () => {
    expect(classifyFailure('canceling statement due to statement timeout', {}).phase).toBe(
      'failed',
    );
  });

  it('keeps the SQL for unknown writes', () => {
    const l = reduceLifecycle(running(), {
      type: 'fail',
      now: 2000,
      message: 'connection terminated',
      isWrite: true,
      sql: 'update t set a = 1',
    });
    expect(l).toMatchObject({ phase: 'unknown', sql: 'update t set a = 1' });
  });
});

describe('lifecycleFromLegacyPatch', () => {
  it('running flag starts a run', () => {
    expect(
      lifecycleFromLegacyPatch(undefined, { queryRunState: 'running', runStartedAt: 5 }, false, 9),
    ).toMatchObject({ phase: 'running', startedAt: 5 });
  });
  it('idle with an error after a run is failed; without is succeeded', () => {
    expect(
      lifecycleFromLegacyPatch(running(), { queryRunState: 'idle', queryError: 'x' }, true, 2000)
        ?.phase,
    ).toBe('failed');
    expect(lifecycleFromLegacyPatch(running(), { queryRunState: 'idle' }, false, 2000)?.phase).toBe(
      'succeeded',
    );
  });
  it('idle with an error and no run is failed (gate refusal)', () => {
    expect(
      lifecycleFromLegacyPatch(IDLE_LIFECYCLE, { queryRunState: 'idle', queryError: 'no' }, true, 1)
        ?.phase,
    ).toBe('failed');
  });
  it('ignores patches without the run flag', () => {
    expect(lifecycleFromLegacyPatch(running(), {}, false, 1)).toBeUndefined();
  });
});

describe('helpers', () => {
  it('formatElapsed', () => {
    expect(formatElapsed(1234)).toBe('1.2s');
    expect(formatElapsed(65_000)).toBe('1m 05s');
  });
  it('writeTarget finds the table a write touches', () => {
    expect(writeTarget('UPDATE public.users SET a = 1')).toEqual({
      schema: 'public',
      table: 'users',
    });
    expect(writeTarget('insert into "My Tbl" values (1)')).toEqual({ table: 'My Tbl' });
    expect(writeTarget('delete from only orders where id=1')).toEqual({ table: 'orders' });
    expect(writeTarget('select 1')).toBeNull();
  });
});
