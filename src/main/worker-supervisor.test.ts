import { EventEmitter } from 'node:events';
import { type UtilityProcess, utilityProcess } from 'electron';
import { afterEach, expect, test, vi } from 'vitest';
import { WorkerSupervisor } from './worker-supervisor';

/**
 * Readiness handshake (U20). The worker posts `{ kind: 'ready' }` under a
 * sentinel id that matches no pending request, so the supervisor has to
 * settle the handshake from the message stream. Without it `start()` hangs
 * for READY_TIMEOUT_MS and main never creates a window.
 */

function fakeWorker() {
  const emitter = new EventEmitter();
  const posted: unknown[] = [];
  // Test double: Electron's UtilityProcess is not constructible outside a
  // real Electron process, and only these members are exercised here.
  const proc = Object.assign(emitter, {
    pid: 4242,
    stdout: null,
    stderr: null,
    postMessage: (msg: unknown) => {
      posted.push(msg);
    },
    kill: () => true,
  }) as unknown as UtilityProcess;
  return { proc, emitter, posted };
}

afterEach(() => {
  vi.restoreAllMocks();
});

test('start() settles on the worker ready message, then routes requests', async () => {
  const { proc, emitter, posted } = fakeWorker();
  vi.spyOn(utilityProcess, 'fork').mockReturnValue(proc);
  const supervisor = new WorkerSupervisor();

  const started = supervisor.start('/tmp/plasma-worker.js');
  emitter.emit('message', { kind: 'ready', id: 'boot' });
  await started;

  const pending = supervisor.request({ kind: 'ping', id: 'p1', message: 'hi' });
  expect(posted).toEqual([{ kind: 'ping', id: 'p1', message: 'hi' }]);

  emitter.emit('message', { kind: 'ping', id: 'p1', echo: 'hi', timestamp: 1 });
  expect(await pending).toEqual({ kind: 'ping', id: 'p1', echo: 'hi', timestamp: 1 });

  supervisor.stop();
});

test('requests before the ready handshake are refused, not queued', async () => {
  const { proc, posted } = fakeWorker();
  vi.spyOn(utilityProcess, 'fork').mockReturnValue(proc);
  const supervisor = new WorkerSupervisor();

  void supervisor.start('/tmp/plasma-worker.js');
  const res = await supervisor.request({ kind: 'ping', id: 'p0', message: 'hi' });

  expect(res).toMatchObject({ kind: 'error', id: 'p0' });
  expect(posted).toEqual([]);

  supervisor.stop();
});

test('a respawn that times out schedules exactly one more restart (C25)', async () => {
  vi.useFakeTimers();
  try {
    const workers: ReturnType<typeof fakeWorker>[] = [];
    vi.spyOn(utilityProcess, 'fork').mockImplementation(() => {
      const w = fakeWorker();
      // kill() makes the process exit, like the real thing.
      (w.proc as unknown as { kill: () => boolean }).kill = () => {
        queueMicrotask(() => w.emitter.emit('exit', null));
        return true;
      };
      workers.push(w);
      return w.proc;
    });
    const supervisor = new WorkerSupervisor();
    const started = supervisor.start('/tmp/plasma-worker.js');
    workers[0]?.emitter.emit('message', { kind: 'ready', id: 'boot' });
    await started;

    workers[0]?.emitter.emit('exit', 1); // crash → respawn after backoff
    await vi.advanceTimersByTimeAsync(300);
    expect(workers).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(15_000); // respawn never readies → killed
    await vi.advanceTimersByTimeAsync(1_000); // one backoff
    expect(workers).toHaveLength(3);
    workers[2]?.emitter.emit('message', { kind: 'ready', id: 'boot' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(workers).toHaveLength(3);

    // The live worker still answers — the dead one's exit didn't null it.
    const pending = supervisor.request({ kind: 'ping', id: 'p9', message: 'x' });
    workers[2]?.emitter.emit('message', { kind: 'ping', id: 'p9', echo: 'x', timestamp: 1 });
    expect(await pending).toMatchObject({ kind: 'ping' });
    supervisor.stop();
  } finally {
    vi.useRealTimers();
  }
});
