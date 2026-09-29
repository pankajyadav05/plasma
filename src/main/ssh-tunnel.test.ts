import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * C6 / C13 / C14 — tunnel bookkeeping with a fake ssh2 client: one tunnel
 * per id, shared concurrent opens, identity-checked close events,
 * keepalive options and cleanup on failure.
 */

const clients: FakeSsh[] = [];
let failNextConnect = false;

class FakeSsh extends EventEmitter {
  opts: Record<string, unknown> | null = null;
  ended = false;
  constructor() {
    super();
    clients.push(this);
  }
  connect(opts: Record<string, unknown>) {
    this.opts = opts;
    const fail = failNextConnect;
    failNextConnect = false;
    setTimeout(() => {
      if (fail) this.emit('error', new Error('auth failed'));
      else this.emit('ready');
    }, 0);
  }
  end() {
    this.ended = true;
  }
  forwardOut() {}
}

vi.mock('ssh2', () => ({ Client: FakeSsh }));
vi.mock('./settings', () => ({ getAllSettings: () => ({}), setSetting: () => {} }));
vi.mock('./logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

const { openTunnel, closeTunnel, closeAllTunnels, openTunnelCount } = await import('./ssh-tunnel');

const target = (id = 'c1', host = 'bastion') => ({
  id,
  ssh: {
    host,
    port: 22,
    user: 'u',
    password: 'p',
    privateKey: '',
    passphrase: '',
  },
  pgHost: 'db',
  pgPort: 5432,
});

beforeEach(() => {
  closeAllTunnels();
  clients.length = 0;
  failNextConnect = false;
});

describe('ssh tunnel manager', () => {
  it('enables keepalives on the ssh client', async () => {
    await openTunnel(target());
    expect(clients[0]?.opts).toMatchObject({ keepaliveInterval: 10_000, keepaliveCountMax: 3 });
    closeTunnel('c1');
  });

  it('shares one attempt between concurrent opens of the same id', async () => {
    const [a, b] = await Promise.all([openTunnel(target()), openTunnel(target())]);
    expect(a.port).toBe(b.port);
    expect(clients).toHaveLength(1);
    expect(openTunnelCount()).toBe(1);
    closeTunnel('c1');
  });

  it('closes on the first closeTunnel (no ref counting)', async () => {
    await openTunnel(target());
    await openTunnel(target());
    closeTunnel('c1');
    expect(openTunnelCount()).toBe(0);
    expect(clients[0]?.ended).toBe(true);
  });

  it("ignores a late 'close' from a replaced client", async () => {
    await openTunnel(target());
    closeTunnel('c1');
    await openTunnel(target());
    expect(clients).toHaveLength(2);
    clients[0]?.emit('close');
    expect(openTunnelCount()).toBe(1);
    clients[1]?.emit('close');
    expect(openTunnelCount()).toBe(0);
  });

  it('replaces a tunnel whose target changed', async () => {
    await openTunnel(target('c1', 'bastion-a'));
    await openTunnel(target('c1', 'bastion-b'));
    expect(clients).toHaveLength(2);
    expect(clients[0]?.ended).toBe(true);
    expect(openTunnelCount()).toBe(1);
    closeTunnel('c1');
  });

  it('ends the ssh client when connecting fails', async () => {
    failNextConnect = true;
    await expect(openTunnel(target())).rejects.toThrow(/auth failed/);
    expect(clients[0]?.ended).toBe(true);
    expect(openTunnelCount()).toBe(0);
    // A second error after the failure must not throw (persistent listener).
    expect(() => clients[0]?.emit('error', new Error('late'))).not.toThrow();
  });

  it('drops a tunnel that was closed while it was still opening', async () => {
    const opening = openTunnel(target());
    closeTunnel('c1');
    await expect(opening).rejects.toThrow(/closed while it was opening/);
    expect(openTunnelCount()).toBe(0);
  });
});
