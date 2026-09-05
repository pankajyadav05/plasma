import { type WorkerRequest, WorkerResponse } from '@shared/protocol';
import {
  extractCorrelatedId,
  ipcDeadlineMs,
  nextBackoffMs,
} from '@shared/worker-policy';
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
export type WorkerBroadcast = Extract<WorkerResponse, { kind: 'redisPubsub' }>;

export class WorkerSupervisor {
  private proc: UtilityProcess | null = null;
  private pending = new Map<
    string,
    { resolve: (res: WorkerResponse) => void; timer?: ReturnType<typeof setTimeout> }
  >();
  private workerEntry: string | null = null;
  private shuttingDown = false;
  private restartDelayMs = 0;
  private broadcastHandler: ((evt: WorkerBroadcast) => void) | null = null;
  private crashHandler: (() => void) | null = null;
  private readyWait: {
    resolve: () => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
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
  }

  private async spawn(): Promise<void> {
    if (!this.workerEntry) throw new Error('workerEntry not set');

    const entry = this.workerEntry;
    const gen = ++this.spawnGeneration;
    this.isReady = false;
    this.clearStableTimer();
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
      const parsed = WorkerResponse.safeParse(raw);
      if (!parsed.success) {
        const id = extractCorrelatedId(raw);
        if (id) {
          const entry = this.pending.get(id);
          if (entry) {
            this.pending.delete(id);
            if (entry.timer) clearTimeout(entry.timer);
            entry.resolve({
              kind: 'error',
              id,
              message: `invalid worker response: ${parsed.error.message}`,
            });
            return;
          }
        }
        logger.error('[plasma] worker sent invalid message', parsed.error);
        return;
      }
      const data = parsed.data;

      if (data.kind === 'ready') {
        this.readyWait?.resolve();
        this.readyWait = null;
        return;
      }

      // Broadcast events (currently only redisPubsub) aren't request-
      // correlated — fan them out to whoever subscribed.
      if (data.kind === 'redisPubsub') {
        this.broadcastHandler?.(data);
        return;
      }
      const entry = this.pending.get(data.id);
      if (entry) {
        this.pending.delete(data.id);
        if (entry.timer) clearTimeout(entry.timer);
        entry.resolve(data);
      }
    });

    proc.on('exit', (code) => {
      logger.warn('[plasma] worker exited code=', code, 'shuttingDown=', this.shuttingDown);
      const wasReady = this.isReady;
      this.isReady = false;
      this.clearStableTimer();

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

      if (!this.shuttingDown) {
        this.scheduleRestart();
      }
    });

    this.proc = proc;

    // Wait for explicit ready — do NOT reset backoff here (U20).
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWait = null;
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
      };
    });

    if (gen !== this.spawnGeneration) return;

    this.isReady = true;

    // Reset backoff only after the worker stays up for a stable window.
    this.stableTimer = setTimeout(() => {
      if (gen === this.spawnGeneration) {
        this.restartDelayMs = 0;
        logger.info('[plasma] worker stable — backoff reset');
      }
    }, WorkerSupervisor.STABLE_UPTIME_MS);
  }

  private scheduleRestart(): void {
    this.restartDelayMs = nextBackoffMs(
      this.restartDelayMs,
      WorkerSupervisor.BASE_BACKOFF_MS,
      WorkerSupervisor.MAX_BACKOFF_MS,
    );
    logger.info('[plasma] restarting worker in', this.restartDelayMs, 'ms');
    setTimeout(() => {
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
      const deadline = ipcDeadlineMs(req.kind);
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (deadline != null) {
        timer = setTimeout(() => {
          if (this.pending.has(req.id)) {
            this.pending.delete(req.id);
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

  stop(): void {
    this.shuttingDown = true;
    this.clearStableTimer();
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
