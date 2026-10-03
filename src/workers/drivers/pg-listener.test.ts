import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { type ListenClient, PgListener } from './pg-listener';

class FakeClient extends EventEmitter {
  queries: string[] = [];
  ended = false;
  async query(sql: string) {
    this.queries.push(sql);
  }
  async end() {
    this.ended = true;
  }
  notify(channel: string, payload = '') {
    this.emit('notification', { channel, payload, processId: 42 });
  }
}

const make = () => {
  const client = new FakeClient();
  const open = vi.fn(async () => client as unknown as ListenClient);
  const listener = new PgListener(open, { flushMs: 5, batchMax: 3 });
  const got: Array<{ channel: string; payload: string }> = [];
  listener.setListener((n) => got.push({ channel: n.channel, payload: n.payload }));
  return { client, open, listener, got };
};
const tick = () => new Promise((r) => setTimeout(r, 30));

describe('PgListener', () => {
  it('quotes channel identifiers and opens one connection for many channels', async () => {
    const { client, open, listener } = make();
    await listener.listen('a');
    await listener.listen('we"ird');
    await listener.listen('a');
    expect(open).toHaveBeenCalledTimes(1);
    expect(client.queries).toEqual(['LISTEN "a"', 'LISTEN "we""ird"']);
    expect(listener.active()).toEqual(['a', 'we"ird']);
  });

  it('rejects invalid channel names', async () => {
    const { listener } = make();
    await expect(listener.listen('')).rejects.toThrow(/invalid/i);
    await expect(listener.listen('a\nb')).rejects.toThrow(/invalid/i);
  });

  it('caps a burst per flush and reports the drop count once', async () => {
    const { client, listener, got } = make();
    await listener.listen('c');
    for (let i = 0; i < 10; i++) client.notify('c', String(i));
    await tick();
    expect(got.filter((g) => g.channel === 'c')).toHaveLength(3);
    expect(got.filter((g) => g.channel === '(plasma)')).toHaveLength(1);
    expect(got.at(-1)?.payload).toMatch(/^7 notifications were dropped/);
  });

  it('closes the connection with the last channel and on close()', async () => {
    const { client, listener } = make();
    await listener.listen('c');
    await listener.unlisten('c');
    expect(client.ended).toBe(true);
    expect(listener.hasConnection()).toBe(false);
    await listener.listen('c');
    await listener.close();
    expect(listener.active()).toEqual([]);
    expect(listener.hasConnection()).toBe(false);
  });

  it('reports a lost connection once and forgets its channels', async () => {
    const { client, listener, got } = make();
    await listener.listen('c');
    client.emit('end');
    client.emit('error', new Error('x'));
    await tick();
    expect(listener.active()).toEqual([]);
    expect(got.filter((g) => g.channel === '(plasma)')).toHaveLength(1);
  });
});
