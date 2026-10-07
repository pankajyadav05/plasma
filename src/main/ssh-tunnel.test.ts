import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * C6 / C13 / C14 — tunnel bookkeeping with a fake ssh2 client: one tunnel
 * per id, shared concurrent opens, identity-checked close events,
 * keepalive options and cleanup on failure.
 */

const clients: FakeSsh[] = [];
let failNextConnect = false;
let hangConnect = false;
const setSettingSpy = vi.hoisted(() => vi.fn());

class FakeSsh extends EventEmitter {
  opts: Record<string, unknown> | null = null;
  ended = false;
  constructor() {
    super();
    clients.push(this);
  }
  connect(opts: Record<string, unknown>) {
    this.opts = opts;
    if (hangConnect) return;
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
vi.mock('./settings', () => ({ getAllSettings: () => ({}), setSetting: setSettingSpy }));
vi.mock('./logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

const {
  openTunnel,
  closeTunnel,
  closeAllTunnels,
  openTunnelCount,
  setHostKeyPrompt,
  HOST_KEY_PROMPT_TIMEOUT_MS,
  SSH_READY_TIMEOUT_MS,
} = await import('./ssh-tunnel');

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
  hangConnect = false;
  setSettingSpy.mockClear();
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

  it('does not hand a pending attempt for another target to a concurrent open (SC-29)', async () => {
    const a = openTunnel(target('c1', 'bastion-a'));
    const b = openTunnel(target('c1', 'bastion-b'));
    const [pa, pb] = await Promise.allSettled([a, b]);
    expect(pa.status).toBe('fulfilled');
    expect(pb.status).toBe('fulfilled');
    // The second caller got its own tunnel to its own target.
    expect(clients).toHaveLength(2);
    expect(clients[1]?.opts).toMatchObject({ host: 'bastion-b' });
    expect(openTunnelCount()).toBe(1);
    closeTunnel('c1');
  });

  it('gives the user longer to compare a fingerprint than ssh2 waits (SC-17)', async () => {
    await openTunnel(target());
    expect(SSH_READY_TIMEOUT_MS).toBeGreaterThan(HOST_KEY_PROMPT_TIMEOUT_MS);
    expect(clients[0]?.opts).toMatchObject({ readyTimeout: SSH_READY_TIMEOUT_MS });
    closeTunnel('c1');
  });

  it('times out an unreachable bastion quickly, before any host-key prompt (SC-17)', async () => {
    vi.useFakeTimers();
    try {
      hangConnect = true;
      const opening = openTunnel(target());
      const assertion = expect(opening).rejects.toThrow(/Timed out while waiting for handshake/);
      await vi.advanceTimersByTimeAsync(15_100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not remember a host key accepted after the attempt already failed (SC-17)', async () => {
    vi.useFakeTimers();
    try {
      hangConnect = true;
      let answer: (ok: boolean) => void = () => {};
      setHostKeyPrompt(
        () =>
          new Promise<boolean>((r) => {
            answer = r;
          }),
      );
      const opening = openTunnel(target());
      const assertion = expect(opening).rejects.toThrow();
      // Handshake reached: the host key is presented and the prompt opens.
      const verifier = clients[0]?.opts?.hostVerifier as (
        key: Buffer,
        verify: (ok: boolean) => void,
      ) => void;
      const verified: boolean[] = [];
      verifier(Buffer.from('ssh-ed25519-fake-key'), (ok) => verified.push(ok));
      clients[0]?.emit('error', new Error('connection dropped'));
      await assertion;
      answer(true); // the user finally clicks Accept
      await vi.advanceTimersByTimeAsync(10);
      expect(verified).toEqual([false]);
      expect(setSettingSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      setHostKeyPrompt(async () => false);
    }
  });
});

describe('forward errors', () => {
  it('keeps the last failure for the connection error, and forgets it once a forward works', async () => {
    const { noteForwardResult, tunnelForwardError } = await import('./ssh-tunnel');
    expect(tunnelForwardError('t-fwd')).toBeUndefined();
    noteForwardResult('t-fwd', new Error('(SSH) Channel open failure: Connection refused'));
    expect(tunnelForwardError('t-fwd')).toMatch(/Connection refused/);
    noteForwardResult('t-fwd', null);
    expect(tunnelForwardError('t-fwd')).toBeUndefined();
  });
});
