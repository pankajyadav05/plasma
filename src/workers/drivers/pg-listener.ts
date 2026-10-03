import {
  PG_LISTEN_MAX_CHANNELS,
  PG_LISTEN_SYSTEM_CHANNEL,
  type PgNotification,
  isValidListenChannel,
  quoteListenChannel,
} from '@shared/pg-listen';

/**
 * LISTEN/NOTIFY on a dedicated connection. The primary session stays free
 * for queries (and its transaction state is never touched); closing the
 * listener never affects it.
 *
 * Flood control mirrors the Redis pub/sub tail: notifications are forwarded
 * in batches every FLUSH_MS, at most BATCH_MAX per flush; the rest are
 * counted and reported in one synthetic `(plasma)` message.
 */

/** The slice of `pg.Client` this class needs (so tests can fake it). */
export interface ListenClient {
  query(sql: string): Promise<unknown>;
  on(
    event: 'notification',
    fn: (msg: { channel: string; payload?: string; processId: number }) => void,
  ): unknown;
  on(event: 'error' | 'end', fn: (err?: Error) => void): unknown;
  end(): Promise<void>;
}

export type PgNotificationListener = (n: PgNotification) => void;

export const PG_LISTEN_FLUSH_MS = 50;
export const PG_LISTEN_BATCH_MAX = 200;
/** A single payload is cut here before it reaches the renderer. */
export const PG_LISTEN_PAYLOAD_MAX_BYTES = 64 * 1024;

export interface PgListenerOptions {
  flushMs?: number;
  batchMax?: number;
}

export class PgListener {
  private client: ListenClient | null = null;
  private opening: Promise<ListenClient> | null = null;
  private readonly channels = new Set<string>();
  private chain: Promise<unknown> = Promise.resolve();
  private out: PgNotification[] = [];
  private dropped = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listener: PgNotificationListener | null = null;
  private generation = 0;
  private readonly flushMs: number;
  private readonly batchMax: number;

  constructor(
    private readonly open: () => Promise<ListenClient>,
    opts: PgListenerOptions = {},
  ) {
    this.flushMs = opts.flushMs ?? PG_LISTEN_FLUSH_MS;
    this.batchMax = opts.batchMax ?? PG_LISTEN_BATCH_MAX;
  }

  setListener(fn: PgNotificationListener | null): void {
    this.listener = fn;
  }

  /** Channels currently listened to. */
  active(): string[] {
    return [...this.channels];
  }

  hasConnection(): boolean {
    return this.client !== null;
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  listen(channel: string): Promise<void> {
    return this.serialize(async () => {
      if (!isValidListenChannel(channel)) throw new Error('Invalid channel name.');
      if (this.channels.has(channel)) return;
      if (this.channels.size >= PG_LISTEN_MAX_CHANNELS) {
        throw new Error(`At most ${PG_LISTEN_MAX_CHANNELS} channels can be listened to at once.`);
      }
      const client = await this.ensureClient();
      await client.query(`LISTEN ${quoteListenChannel(channel)}`);
      this.channels.add(channel);
    });
  }

  unlisten(channel: string): Promise<void> {
    return this.serialize(async () => {
      if (!this.channels.has(channel)) return;
      this.channels.delete(channel);
      const client = this.client;
      if (client)
        await client.query(`UNLISTEN ${quoteListenChannel(channel)}`).catch(() => undefined);
      // Nothing left to listen to: give the connection back to the server.
      if (this.channels.size === 0) await this.dropClient();
    });
  }

  /** Disconnect / tab close: drop every listener and the connection itself. */
  close(): Promise<void> {
    return this.serialize(async () => {
      this.channels.clear();
      await this.dropClient();
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.out = [];
      this.dropped = 0;
    });
  }

  private ensureClient(): Promise<ListenClient> {
    if (this.client) return Promise.resolve(this.client);
    if (!this.opening) {
      const gen = ++this.generation;
      const p = this.open().then(
        (client) => {
          if (gen !== this.generation) {
            // close() ran while we were dialling.
            void client.end().catch(() => undefined);
            throw new Error('Listener was closed.');
          }
          client.on('notification', (msg) => this.onNotification(gen, msg));
          client.on('error', () => this.onLost(gen));
          client.on('end', () => this.onLost(gen));
          this.client = client;
          return client;
        },
        (err) => {
          throw err;
        },
      );
      const clear = () => {
        if (this.opening === p) this.opening = null;
      };
      p.then(clear, clear);
      this.opening = p;
    }
    return this.opening;
  }

  private async dropClient(): Promise<void> {
    this.generation++;
    const c = this.client;
    this.client = null;
    this.opening = null;
    if (c) await c.end().catch(() => undefined);
  }

  private onLost(gen: number): void {
    if (gen !== this.generation || !this.client) return;
    // The connection died under us (server restart, network): say so once.
    this.client = null;
    this.generation++;
    const had = this.channels.size;
    this.channels.clear();
    if (had > 0) {
      this.emit({
        channel: PG_LISTEN_SYSTEM_CHANNEL,
        payload: 'The listener connection was lost. Start listening again to resume.',
        pid: 0,
        timestamp: Date.now(),
      });
    }
  }

  private onNotification(
    gen: number,
    msg: { channel: string; payload?: string; processId: number },
  ): void {
    if (gen !== this.generation) return;
    let payload = msg.payload ?? '';
    if (Buffer.byteLength(payload, 'utf8') > PG_LISTEN_PAYLOAD_MAX_BYTES) {
      payload = `${payload.slice(0, PG_LISTEN_PAYLOAD_MAX_BYTES)}…`;
    }
    this.emit({ channel: msg.channel, payload, pid: msg.processId, timestamp: Date.now() });
  }

  private emit(n: PgNotification): void {
    if (this.out.length >= this.batchMax) this.dropped++;
    else this.out.push(n);
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.flushMs);
      this.timer.unref?.();
    }
  }

  private flush(): void {
    this.timer = null;
    const out = this.out;
    this.out = [];
    const dropped = this.dropped;
    this.dropped = 0;
    for (const n of out) this.listener?.(n);
    if (dropped > 0) {
      this.listener?.({
        channel: PG_LISTEN_SYSTEM_CHANNEL,
        payload: `${dropped.toLocaleString('en-US')} notifications were dropped: the channel is faster than the viewer can show.`,
        pid: 0,
        timestamp: Date.now(),
      });
    }
  }
}
