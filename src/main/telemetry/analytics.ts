import { randomUUID } from 'node:crypto';
import type { AnalyticsEventName, AnalyticsEvents } from './events';

/** Retry delays shorter than this still wait for the next background check. */
const FLUSH_INTERVAL_MS = 10_000;
/** A hung send would otherwise hold up the shutdown flush. */
const SEND_TIMEOUT_MS = 10_000;
const FLUSH_BATCH_SIZE = 20;
const MAX_BUFFERED_EVENTS = 1_000;
/** A failed batch is retried until it has been failing this long, then dropped. */
const MAX_BATCH_RETRY_MS = 30 * 60_000;
const RETRY_BASE_DELAY_MS = 2_000;
const RETRY_MAX_DELAY_MS = 300_000;
/** These statuses reject the batch itself; unlike 408/429, retrying cannot help. */
const REJECTED_BATCH_STATUSES = new Set([400, 401, 413]);

/** `random` is in [0, 1). */
function retryDelayMs(failures: number, random: number): number {
  const ceiling = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (failures - 1));
  return Math.round(ceiling / 2 + (ceiling / 2) * random);
}

interface BufferedEvent {
  readonly uuid: string;
  readonly event: AnalyticsEventName;
  readonly properties: object;
  readonly capturedAt: string;
}

export interface AnalyticsDeps {
  readonly posthogKey: string;
  readonly posthogHost: string;
  /** Sent with every event. */
  readonly common: Readonly<Record<string, string>>;
  /** Called on the first event only, so an install with analytics off never creates an id. */
  readonly installId: () => string | null;
  readonly fetch: typeof fetch;
  readonly log: { warn(message: string): void; debug(message: string): void };
}

/**
 * Buffers events in memory and posts them to PostHog's batch endpoint from the
 * main process (the renderer's CSP stays closed; it loads no SDK). Every event
 * gets its uuid when recorded, so PostHog deduplicates a retry whose first send
 * was stored after all. Best effort: nothing here throws or blocks the app, and
 * nothing is kept on disk.
 */
export class AnalyticsService {
  private buffer: BufferedEvent[] = [];
  private failedBatch: BufferedEvent[] = [];
  private batchAttempts = 0;
  private firstFailedAt = 0;
  private failures = 0;
  private retryAt = 0;
  private flushing: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private distinctId: string | null | undefined;
  private stopped = false;

  constructor(
    private readonly deps: AnalyticsDeps,
    private enabled: boolean,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flushWhenDue(), FLUSH_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** Turning analytics off also forgets whatever had not been sent yet. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.clear();
  }

  record<E extends AnalyticsEventName>(event: E, properties: AnalyticsEvents[E]): void {
    if (!this.enabled) return;
    if (this.distinctId === undefined) this.distinctId = this.deps.installId();
    if (this.distinctId === null) return;
    this.buffer.push({
      uuid: randomUUID(),
      event,
      properties,
      capturedAt: new Date().toISOString(),
    });
    if (this.buffer.length > MAX_BUFFERED_EVENTS) {
      this.buffer.splice(0, this.buffer.length - MAX_BUFFERED_EVENTS);
    }
  }

  hasPending(): boolean {
    if (this.stopped) return false;
    return this.buffer.length > 0 || this.failedBatch.length > 0 || this.flushing !== null;
  }

  /** Send what is buffered. The background flush and a shutdown flush never overlap. */
  flush(): Promise<void> {
    this.flushing ??= this.drain().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  /** One last send within `timeoutMs`; whatever did not make it is dropped. */
  async shutdown(timeoutMs: number): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.flush(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timeout);
    this.setEnabled(false);
    // A send still out cannot hold the quit: it ends with its own timeout or with the process.
    this.stopped = true;
  }

  private flushWhenDue(): Promise<void> {
    return Date.now() >= this.retryAt ? this.flush() : Promise.resolve();
  }

  private clear(): void {
    this.buffer = [];
    this.failedBatch = [];
    this.batchAttempts = 0;
    this.firstFailedAt = 0;
  }

  private async drain(): Promise<void> {
    while (true) {
      const batch =
        this.failedBatch.length > 0 ? this.failedBatch : this.buffer.splice(0, FLUSH_BATCH_SIZE);
      if (batch.length === 0) return;

      const outcome = await this.send(batch);
      // Turned off while that send was out: nothing may go after it.
      if (!this.enabled) {
        this.clear();
        return;
      }
      if (outcome === 'sent') {
        this.failedBatch = [];
        this.batchAttempts = 0;
        this.firstFailedAt = 0;
        this.failures = 0;
        this.retryAt = 0;
        continue;
      }

      const now = Date.now();
      const attempts = this.batchAttempts + 1;
      const firstFailedAt = this.batchAttempts === 0 ? now : this.firstFailedAt;
      this.failures += 1;
      // Back off even after dropping a rejected batch, so a bad key cannot drain the queue in a tight loop.
      this.retryAt = now + retryDelayMs(this.failures, Math.random());
      if (outcome === 'failed' && now - firstFailedAt < MAX_BATCH_RETRY_MS) {
        this.failedBatch = batch;
        this.batchAttempts = attempts;
        this.firstFailedAt = firstFailedAt;
        this.deps.log.debug(`[plasma] analytics send failed (attempt ${attempts}); will retry`);
        return;
      }
      this.failedBatch = [];
      this.batchAttempts = 0;
      this.firstFailedAt = 0;
      this.deps.log.warn(
        outcome === 'rejected'
          ? `[plasma] analytics endpoint rejected a batch of ${batch.length} events; dropped`
          : `[plasma] dropped ${batch.length} analytics events after ${attempts} failed sends`,
      );
      return;
    }
  }

  private async send(batch: readonly BufferedEvent[]): Promise<'sent' | 'rejected' | 'failed'> {
    try {
      const res = await this.deps.fetch(`${this.deps.posthogHost}/batch/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        body: JSON.stringify({
          api_key: this.deps.posthogKey,
          batch: batch.map((e) => ({
            uuid: e.uuid,
            event: e.event,
            distinct_id: this.distinctId,
            timestamp: e.capturedAt,
            properties: {
              ...e.properties,
              ...this.deps.common,
              installId: this.distinctId,
              // No person profile, and no location looked up from the sender's address.
              $process_person_profile: false,
              $geoip_disable: true,
            },
          })),
        }),
      });
      if (res.ok) return 'sent';
      return REJECTED_BATCH_STATUSES.has(res.status) ? 'rejected' : 'failed';
    } catch {
      return 'failed';
    }
  }
}
