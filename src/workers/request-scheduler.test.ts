import { describe, expect, it } from 'vitest';
import { RequestScheduler, StaleRequestError, laneFor } from './request-scheduler';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('laneFor', () => {
  it('routes session plumbing, primary and aux statements', () => {
    expect(laneFor('connect')).toBe('lifecycle');
    expect(laneFor('disconnect')).toBe('lifecycle');
    expect(laneFor('query')).toBe('primary');
    expect(laneFor('commitEditBatch')).toBe('primary');
    expect(laneFor('aiQuery')).toBe('aux');
    expect(laneFor('cancel')).toBe('free');
    expect(laneFor('redisScan')).toBe('free');
  });
});

describe('RequestScheduler', () => {
  it('never overlaps two connects', async () => {
    const s = new RequestScheduler();
    const order: string[] = [];
    const first = deferred();
    const a = s.run('connect', async () => {
      order.push('a:start');
      await first.promise;
      order.push('a:end');
    });
    const b = s.run('connect', async () => {
      order.push('b:start');
    });
    await tick();
    expect(order).toEqual(['a:start']);
    first.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
  });

  it('holds queries until an in-progress connect finishes', async () => {
    const s = new RequestScheduler();
    const gate = deferred();
    const order: string[] = [];
    const c = s.run('connect', async () => {
      await gate.promise;
      order.push('connect');
    });
    const q = s.run('query', async () => {
      order.push('query');
    });
    await tick();
    expect(order).toEqual([]);
    gate.resolve();
    await Promise.all([c, q]);
    expect(order).toEqual(['connect', 'query']);
  });

  it('keeps multi-step primary work atomic', async () => {
    const s = new RequestScheduler();
    const order: string[] = [];
    const batch = deferred();
    const a = s.run('commitEditBatch', async () => {
      order.push('BEGIN');
      await batch.promise;
      order.push('COMMIT');
    });
    const b = s.run('query', async () => {
      order.push('user query');
    });
    await tick();
    batch.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(['BEGIN', 'COMMIT', 'user query']);
  });

  it('lets cancel through while a query is running', async () => {
    const s = new RequestScheduler();
    const running = deferred();
    const q = s.run('query', () => running.promise);
    let cancelled = false;
    await s.run('cancel', async () => {
      cancelled = true;
    });
    expect(cancelled).toBe(true);
    running.resolve();
    await q;
  });

  it('rejects queued work meant for a session that was replaced', async () => {
    const s = new RequestScheduler();
    const running = deferred();
    const first = s.run('query', () => running.promise);
    const queued = s.run('query', async () => 'ran');
    const reconnect = s.run('connect', async () => undefined);
    await reconnect;
    running.resolve();
    await first;
    await expect(queued).rejects.toBeInstanceOf(StaleRequestError);
    // Work that arrives after the connect runs normally.
    await expect(s.run('query', async () => 'fresh')).resolves.toBe('fresh');
  });

  it('does not treat a statement-timeout change as a new session', async () => {
    const s = new RequestScheduler();
    const running = deferred();
    const first = s.run('query', () => running.promise);
    const queued = s.run('query', async () => 'ran');
    await s.run('setStatementTimeout', async () => undefined);
    running.resolve();
    await first;
    await expect(queued).resolves.toBe('ran');
  });

  it('a failed op does not wedge its lane', async () => {
    const s = new RequestScheduler();
    await expect(
      s.run('query', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(s.run('query', async () => 1)).resolves.toBe(1);
    await expect(
      s.run('connect', async () => {
        throw new Error('refused');
      }),
    ).rejects.toThrow('refused');
    await expect(s.run('connect', async () => 2)).resolves.toBe(2);
  });
});
