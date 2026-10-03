import type { WorkerRequest, WorkerResponse } from '@shared/protocol';
import {
  cancelRequestFor,
  holdsExclusiveLane,
  ipcDeadlineMs,
  nextBackoffMs,
} from '@shared/worker-policy';
import { parseWorkerResponse } from '@shared/worker-response-parse';
import { type UtilityProcess, utilityProcess } from 'electron';
import { logger } from './logger';

/**
 * Worker supervisor — owns the lifecycle of the DB worker process and
 * routes typed request/response over its MessagePort.
 *
 * Features (U20):
 *   - Explicit readiness handshake before accepting requests
 *   - Auto-restart on unexpected exit with exponential backoff,
 *     reset only after stable uptime (not immediately after fork)
 *   - Reject all in-flight pending requests on crash so callers unhang
 *   - Bounded pending queue + per-op IPC deadlines (SQL excluded —
 *     those use PG statement_timeout)
 *   - Invalid envelopes settle the correlated id when present
 *   - Crash callback so main can invalidate connection state
 *   - Graceful shutdown (signalled by `stop()`)
 */
/**
 * Worker → main events that aren't request-correlated. The supervisor
 * routes them to a registered handler instead of trying to resolve a
 * pending promise.
 */
export type WorkerBroadcast = Extract<
  WorkerResponse,
  | { kind: 'redisPubsub' }
  | { kind: 'queryChunk' }
  | { kind: 'pgNotice' }
  | { kind: 'pgNotification' }
  | { kind: 'importProgress' }
  | { kind: 'exportProgress' }
>;

/** Tunables a test can shrink; production uses the defaults. */
export interface WorkerSupervisorOptions {
  /** Watchdog ping period; 0 disables the watchdog. */
  watchdogIntervalMs?: number;
  /** How long one watchdog ping may go unanswered. */
  watchdogPingTimeoutMs?: number;
  /** Consecutive missed pings before the worker is recycled. */
  watchdogMaxMisses?: number;
  /** A timed-out exclusive-lane request still unanswered this long after its cancel recycles the worker. */
  stuckAfterCancelMs?: number;
}

export class WorkerSupervisor {
  private proc: UtilityProcess | null = null;
  private pending = new Map<
    string,
    { resolve: (res: WorkerResponse) => void; timer?: ReturnType<typeof setTimeout> }
  >();
  /** Requests whose IPC deadline passed but the worker has not answered yet (SC-06/SC-12). */
  private abandoned = new Map<string, { kind: WorkerRequest['kind']; cancelledAt: number }>();
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogMisses = 0;
  private watchdogInFlight = false;
  private watchdogSeq = 0;
  private readonly opts: Required<WorkerSupervisorOptions>;
  private workerEntry: string | null = null;
  private shuttingDown = false;
  private restartDelayMs = 0;
  private broadcastHandler: ((evt: WorkerBroadcast) => void) | null = null;
  private crashHandler: (() => void) | null = null;
  private readyWait: {
    resolve: () => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    proc: UtilityProcess;
  } | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private spawnGeneration = 0;
  /** True once the current process has completed the ready handshake. */
  private isReady = false;

  private static readonly BASE_BACKOFF_MS = 250;
  private static readonly MAX_BACKOFF_MS = 10_000;
  private static readonly STABLE_UPTIME_MS = 5_000;
  private static readonly READY_TIMEOUT_MS = 15_000;
  private static readonly MAX_PENDING = 128;

  constructor(options: WorkerSupervisorOptions = {}) {
    this.opts = {
      watchdogIntervalMs: options.watchdogIntervalMs ?? 20_000,
      watchdogPingTimeoutMs: options.watchdogPingTimeoutMs ?? 5_000,
      watchdogMaxMisses: options.watchdogMaxMisses ?? 3,
      stuckAfterCancelMs: options.stuckAfterCancelMs ?? 30_000,
    };
  }

  /** Subscribe to non-correlated worker events. Replaces any prior handler. */
  setBroadcastHandler(handler: ((evt: WorkerBroadcast) => void) | null): void {
    this.broadcastHandler = handler;
  }

  /**
   * Called when the worker exits unexpectedly after it was ready.
   * Main uses this to clear connection identity and notify the renderer.
   */
  setCrashHandler(handler: (() => void) | null): void {
    this.crashHandler = handler;
  }

  async start(workerEntry: string): Promise<void> {
    this.workerEntry = workerEntry;
    this.shuttingDown = false;
    await this.spawn();
  }

  private clearStableTimer(): void {
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }

  private rejectAllPending(message: string): void {
    for (const [id, entry] of this.pending.entries()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve({ kind: 'error', id, message });
    }
    this.pending.clear();
    this.abandoned.clear();
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
    this.watchdogMisses = 0;
    this.watchdogInFlight = false;
  }

  /**
   * SC-12: a wedged worker (native hang, blackholed query holding the
   * FIFO lane) would otherwise fill the pending map and stay dead until
   * the app restarts. Ping it on the free lane; after N misses, or when a
   * timed-out exclusive job ignores its cancel, kill it and let the
   * normal crash path restart it.
   */
  private startWatchdog(): void {
    this.stopWatchdog();
    if (this.opts.watchdogIntervalMs <= 0) return;
    const proc = this.proc;
    this.watchdogTimer = setInterval(() => {
      if (proc !== this.proc || !this.isReady) return;
      const now = Date.now();
      for (const [id, a] of this.abandoned) {
        if (holdsExclusiveLane(a.kind) && now - a.cancelledAt >= this.opts.stuckAfterCancelMs) {
          this.recycle(`request ${a.kind} ignored its cancel (${id})`);
          return;
        }
      }
      if (this.watchdogInFlight) return;
      this.watchdogInFlight = true;
      const id = `watchdog-${++this.watchdogSeq}`;
      void this.pingFor(id).then((ok) => {
        this.watchdogInFlight = false;
        if (proc !== this.proc) return;
        if (ok) {
          this.watchdogMisses = 0;
          return;
        }
        this.watchdogMisses++;
        if (this.watchdogMisses >= this.opts.watchdogMaxMisses) {
          this.recycle(`${this.watchdogMisses} watchdog pings unanswered`);
        }
      });
    }, this.opts.watchdogIntervalMs);
    this.watchdogTimer.unref?.();
  }

  private pingFor(id: string): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.proc) return resolve(false);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(false);
      }, this.opts.watchdogPingTimeoutMs);
      this.pending.set(id, {
        resolve: (res) => {
          clearTimeout(timer);
          resolve(res.kind === 'ping');
        },
        timer,
      });
      this.proc.postMessage({ kind: 'ping', id, message: 'watchdog' });
    });
  }

  /** Kill the current worker; its exit handler rejects pending work and schedules the restart. */
  private recycle(reason: string): void {
    logger.error('[plasma] recycling worker:', reason);
    this.stopWatchdog();
    try {
      this.proc?.kill();
    } catch {
      // ignore
    }
  }

  private async spawn(): Promise<void> {
    if (!this.workerEntry) throw new Error('workerEntry not set');

    const entry = this.workerEntry;
    const gen = ++this.spawnGeneration;
    this.isReady = false;
    this.clearStableTimer();
    this.stopWatchdog();
    // SC-11: never leave a previous process behind when taking over.
    if (this.proc) {
      const old = this.proc;
      this.proc = null;
      try {
        old.kill();
      } catch {
        // ignore
      }
    }
    logger.info('[plasma] spawning worker at', entry);

    const proc = utilityProcess.fork(entry, [], {
      serviceName: 'plasma-db-worker',
      stdio: 'pipe',
    });

    proc.stdout?.on('data', (chunk) => {
      process.stdout.write(`[worker] ${chunk}`);
    });
    proc.stderr?.on('data', (chunk) => {
      process.stderr.write(`[worker:err] ${chunk}`);
    });

    proc.on('message', (raw: unknown) => {
      // C25: a process we already gave up on must not settle anything.
      if (proc !== this.proc) return;
      // U15 step 3: queryResult uses envelope validation (no per-cell Zod walk).
      const parsed = parseWorkerResponse(raw);
      if (!parsed.ok) {
        logger.error('[plasma] worker sent invalid message', parsed.error);
        return;
      }
      const data = parsed.data;
      // Broadcast events aren't request-correlated final responses — fan them
      // out to whoever subscribed (redis pubsub, query chunks, pg notices).
      if (
        data.kind === 'redisPubsub' ||
        data.kind === 'queryChunk' ||
        data.kind === 'pgNotice' ||
        data.kind === 'pgNotification' ||
        data.kind === 'importProgress' ||
        data.kind === 'exportProgress'
      ) {
        this.broadcastHandler?.(data);
        return;
      }
      // Readiness is not request-correlated: the worker posts it at boot
      // under a sentinel id, so settle the handshake here instead of
      // looking for a pending request (U20).
      if (data.kind === 'ready') {
        const wait = this.readyWait;
        this.readyWait = null;
        wait?.resolve();
        return;
      }
      this.abandoned.delete(data.id);
      const entry = this.pending.get(data.id);
      if (entry) {
        this.pending.delete(data.id);
        if (entry.timer) clearTimeout(entry.timer);
        entry.resolve(data);
      }
    });

    proc.on('exit', (code) => {
      logger.warn('[plasma] worker exited code=', code, 'shuttingDown=', this.shuttingDown);
      // C25: a superseded process (killed after a ready timeout) must not
      // null out or restart its live successor; the failed spawn()
      // already schedules the one restart.
      if (proc !== this.proc) return;
      const wasReady = this.isReady;
      this.isReady = false;
      this.clearStableTimer();
      this.stopWatchdog();

      if (this.readyWait) {
        const wait = this.readyWait;
        this.readyWait = null;
        wait.reject(new Error(`worker exited before ready (code ${code ?? 'null'})`));
      }

      this.rejectAllPending(`worker exited unexpectedly (code ${code ?? 'null'})`);
      this.proc = null;

      if (wasReady && !this.shuttingDown) {
        try {
          this.crashHandler?.();
        } catch (err) {
          logger.error('[plasma] crash handler failed', err);
        }
      }

      // scheduleRestart is idempotent, so the spawn() failure caused by an
      // exit before ready and this path can't double-schedule (SC-11).
      if (!this.shuttingDown) {
        this.scheduleRestart();
      }
    });

    this.proc = proc;

    // Wait for explicit ready — do NOT reset backoff here (U20).
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Only clear the handshake if it is still ours; a newer process owns its own.
        if (this.readyWait?.proc === proc) this.readyWait = null;
        if (this.proc === proc) this.proc = null;
        try {
          proc.kill();
        } catch {
          // ignore
        }
        reject(new Error('worker ready timeout'));
      }, WorkerSupervisor.READY_TIMEOUT_MS);
      this.readyWait = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        timer,
        proc,
      };
    });

    if (gen !== this.spawnGeneration) return;

    this.isReady = true;
    this.startWatchdog();

    // Reset backoff only after the worker stays up for a stable window.
    this.stableTimer = setTimeout(() => {
      if (gen === this.spawnGeneration) {
        this.restartDelayMs = 0;
        logger.info('[plasma] worker stable — backoff reset');
      }
    }, WorkerSupervisor.STABLE_UPTIME_MS);
  }

  private scheduleRestart(): void {
    if (this.shuttingDown || this.restartTimer) return;
    this.restartDelayMs = nextBackoffMs(
      this.restartDelayMs,
      WorkerSupervisor.BASE_BACKOFF_MS,
      WorkerSupervisor.MAX_BACKOFF_MS,
    );
    logger.info('[plasma] restarting worker in', this.restartDelayMs, 'ms');
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.shuttingDown) {
        void this.spawn().catch((err) => {
          logger.error('[plasma] worker respawn failed', err);
          this.scheduleRestart();
        });
      }
    }, this.restartDelayMs);
  }

  request(req: WorkerRequest): Promise<WorkerResponse> {
    if (!this.proc || !this.isReady) {
      return Promise.resolve({
        kind: 'error',
        id: req.id,
        message: 'worker not available (crashed or not started)',
      });
    }
    if (this.pending.size >= WorkerSupervisor.MAX_PENDING) {
      return Promise.resolve({
        kind: 'error',
        id: req.id,
        message: `worker request queue full (max ${WorkerSupervisor.MAX_PENDING})`,
      });
    }
    return new Promise((resolve) => {
      const deadline = ipcDeadlineMs(req.kind, req);
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (deadline != null) {
        timer = setTimeout(() => {
          if (this.pending.has(req.id)) {
            this.pending.delete(req.id);
            // SC-06: stop the work too, or it keeps running (and holding
            // its lane) while the caller is told it failed.
            this.cancelAbandoned(req);
            resolve({
              kind: 'error',
              id: req.id,
              message: `worker request timed out after ${deadline}ms (${req.kind})`,
            });
          }
        }, deadline);
      }
      this.pending.set(req.id, { resolve, timer });
      this.proc?.postMessage(req);
    });
  }

  private cancelAbandoned(req: WorkerRequest): void {
    const cancel = cancelRequestFor(req, `timeout-cancel-${req.id}`);
    this.abandoned.set(req.id, { kind: req.kind, cancelledAt: Date.now() });
    if (cancel) this.proc?.postMessage(cancel);
  }

  /** E2E only — pid of the current utility-process child, or null. */
  workerPid(): number | null {
    return this.proc?.pid ?? null;
  }

  /** E2E only — SIGKILL the worker so restart / reset paths can be tested. */
  killWorkerForE2E(): void {
    this.proc?.kill();
  }

  stop(): void {
    this.shuttingDown = true;
    this.clearStableTimer();
    this.stopWatchdog();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.readyWait) {
      clearTimeout(this.readyWait.timer);
      this.readyWait = null;
    }
    this.proc?.kill();
    this.proc = null;
    this.isReady = false;
    this.rejectAllPending('worker stopped');
  }
}
