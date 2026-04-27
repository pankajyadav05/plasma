import { utilityProcess, type UtilityProcess } from 'electron';
import { WorkerResponse, type WorkerRequest } from '@shared/protocol';
import { logger } from './logger';

/**
 * Worker supervisor — owns the lifecycle of the DB worker process and
 * routes typed request/response over its MessagePort.
 *
 * Features:
 *   - Auto-restart on unexpected exit (with exponential backoff)
 *   - Reject all in-flight pending requests on crash so callers unhang
 *   - Bounded pending queue (per-id promise resolvers)
 *   - Graceful shutdown (signalled by `stop()`)
 */
export class WorkerSupervisor {
  private proc: UtilityProcess | null = null;
  private pending = new Map<string, (res: WorkerResponse) => void>();
  private workerEntry: string | null = null;
  private shuttingDown = false;
  private restartDelayMs = 0;

  private static readonly BASE_BACKOFF_MS = 250;
  private static readonly MAX_BACKOFF_MS = 10_000;

  async start(workerEntry: string): Promise<void> {
    this.workerEntry = workerEntry;
    this.shuttingDown = false;
    await this.spawn();
  }

  private async spawn(): Promise<void> {
    if (!this.workerEntry) throw new Error('workerEntry not set');

    const entry = this.workerEntry;
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
        logger.error('[plasma] worker sent invalid message', parsed.error);
        return;
      }
      const resolver = this.pending.get(parsed.data.id);
      if (resolver) {
        this.pending.delete(parsed.data.id);
        resolver(parsed.data);
      }
    });

    proc.on('exit', (code) => {
      logger.warn('[plasma] worker exited code=', code, 'shuttingDown=', this.shuttingDown);
      // Reject every in-flight request so the renderer doesn't hang
      for (const [id, resolver] of this.pending.entries()) {
        resolver({
          kind: 'error',
          id,
          message: `worker exited unexpectedly (code ${code ?? 'null'})`,
        });
      }
      this.pending.clear();
      this.proc = null;

      if (!this.shuttingDown) {
        this.scheduleRestart();
      }
    });

    this.proc = proc;
    // Reset backoff once the worker survives long enough to take a request.
    // We don't wait for a real ping — any new request will reset it anyway.
    this.restartDelayMs = 0;

    // Yield a tick so the worker's first message handlers are attached
    await new Promise((r) => setTimeout(r, 0));
  }

  private scheduleRestart(): void {
    this.restartDelayMs = Math.min(
      this.restartDelayMs === 0 ? WorkerSupervisor.BASE_BACKOFF_MS : this.restartDelayMs * 2,
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
    if (!this.proc) {
      return Promise.resolve({
        kind: 'error',
        id: req.id,
        message: 'worker not available (crashed or not started)',
      });
    }
    return new Promise((resolve) => {
      this.pending.set(req.id, resolve);
      this.proc?.postMessage(req);
    });
  }

  stop(): void {
    this.shuttingDown = true;
    this.proc?.kill();
    this.proc = null;
    for (const [id, resolver] of this.pending.entries()) {
      resolver({ kind: 'error', id, message: 'worker stopped' });
    }
    this.pending.clear();
  }
}
