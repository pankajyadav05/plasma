import { ConnectionLostError } from '@shared/connection-loss';
import type { ConnectionConfig } from '@shared/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConnectionRecovery,
  type RecoveryDeps,
  type RetainedSession,
  recoveryPolicy,
} from './connection-recovery';

/**
 * U27 — main's half of VPN recovery: rebuild the session once, retry the
 * request that died with the transport, and never replay a write.
 */

const config: ConnectionConfig = {
  id: 'conn-1',
  name: 'prod',
  engine: 'postgres',
  host: 'db.internal',
  port: 5432,
  database: 'app',
  user: 'app',
  password: 'secret',
  ssl: false,
  readOnly: false,
};

function harness(overrides: Partial<RecoveryDeps> = {}) {
  const session: RetainedSession = { id: 'conn-1', config, tunnelled: false };
  const deps = {
    session: vi.fn(() => session as RetainedSession | null),
    reopenTunnel: vi.fn(async () => ({ host: '127.0.0.1', port: 54321 })),
    connect: vi.fn(async () => ({
      serverVersion: 'PostgreSQL 16.6',
      engine: 'postgres' as const,
      connectionGen: 7,
      attempts: 1,
    })),
    onRecovered: vi.fn(),
    onLost: vi.fn(),
    log: vi.fn(),
    ...overrides,
  } satisfies RecoveryDeps;
  return { deps, recovery: new ConnectionRecovery(deps), session };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recoveryPolicy', () => {
  it('retries reads', () => {
    expect(recoveryPolicy('query')).toBe('retry');
    expect(recoveryPolicy('introspect')).toBe('retry');
    expect(recoveryPolicy('redisScan')).toBe('retry');
    expect(recoveryPolicy('osSearch')).toBe('retry');
  });

  it('reconnects without replaying writes and generation-bound work', () => {
    expect(recoveryPolicy('commitEditBatch')).toBe('reconnect-only');
    expect(recoveryPolicy('redisWrite')).toBe('reconnect-only');
    expect(recoveryPolicy('exportQuery')).toBe('reconnect-only');
    expect(recoveryPolicy('cancel')).toBe('reconnect-only');
  });

  it('keeps session plumbing out of recovery so it cannot recurse', () => {
    expect(recoveryPolicy('connect')).toBe('none');
    expect(recoveryPolicy('disconnect')).toBe('none');
    expect(recoveryPolicy('testConnect')).toBe('none');
  });
});

describe('ConnectionRecovery.run', () => {
  it('reconnects and retries a read that died with the transport', async () => {
    const { deps, recovery } = harness();
    const call = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new ConnectionLostError('primary reset'))
      .mockResolvedValueOnce('rows');

    await expect(recovery.run('query', call)).resolves.toBe('rows');
    expect(call).toHaveBeenCalledTimes(2);
    expect(deps.connect).toHaveBeenCalledTimes(1);
    expect(deps.onRecovered).toHaveBeenCalledWith(expect.objectContaining({ connectionGen: 7 }));
  });

  it('leaves a statement-level failure untouched', async () => {
    const { deps, recovery } = harness();
    const call = vi.fn(async () => {
      throw new Error('relation "nope" does not exist');
    });

    await expect(recovery.run('query', call)).rejects.toThrow(/does not exist/);
    expect(call).toHaveBeenCalledTimes(1);
    expect(deps.connect).not.toHaveBeenCalled();
  });

  it('does not replay a write, but still restores the session for later work', async () => {
    const { deps, recovery } = harness();
    const call = vi.fn(async () => {
      throw new ConnectionLostError('primary reset');
    });

    await expect(recovery.run('commitEditBatch', call)).rejects.toThrow(/connection lost/);
    expect(call).toHaveBeenCalledTimes(1);
    expect(deps.connect).toHaveBeenCalledTimes(1);
  });

  it('never recovers around session plumbing itself', async () => {
    const { deps, recovery } = harness();
    const call = vi.fn(async () => {
      throw new ConnectionLostError('server gone');
    });

    await expect(recovery.run('connect', call)).rejects.toThrow(/connection lost/);
    expect(call).toHaveBeenCalledTimes(1);
    expect(deps.connect).not.toHaveBeenCalled();
  });

  it('opens one session for a burst of simultaneous failures', async () => {
    const { deps, recovery } = harness();
    const make = () =>
      vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(new ConnectionLostError('primary reset'))
        .mockResolvedValueOnce('rows');

    const results = await Promise.all([
      recovery.run('query', make()),
      recovery.run('introspect', make()),
      recovery.run('redisScan', make()),
    ]);

    expect(results).toEqual(['rows', 'rows', 'rows']);
    expect(deps.connect).toHaveBeenCalledTimes(1);
  });

  it('re-forwards the SSH tunnel before reconnecting a tunnelled session', async () => {
    const { deps, recovery } = harness({
      session: vi.fn(() => ({ id: 'conn-1', config, tunnelled: true }) as RetainedSession | null),
    });
    const call = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new ConnectionLostError('tunnel died'))
      .mockResolvedValueOnce('rows');

    await expect(recovery.run('query', call)).resolves.toBe('rows');
    expect(deps.reopenTunnel).toHaveBeenCalledTimes(1);
    expect(deps.connect).toHaveBeenCalledWith(expect.objectContaining({ tunnelled: true }), {
      host: '127.0.0.1',
      port: 54321,
    });
  });

  it('surfaces the original failure and reports the session gone when reconnect fails', async () => {
    const { deps, recovery } = harness({
      connect: vi.fn(async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.5:5432');
      }),
    });
    const call = vi.fn(async () => {
      throw new ConnectionLostError('primary reset');
    });

    await expect(recovery.run('query', call)).rejects.toThrow(/primary reset/);
    expect(call).toHaveBeenCalledTimes(1);
    expect(deps.onLost).toHaveBeenCalledWith(expect.stringMatching(/ECONNREFUSED/));
    expect(deps.onRecovered).not.toHaveBeenCalled();
  });

  it('reports the session gone when there is nothing retained to rebuild', async () => {
    const { deps, recovery } = harness({ session: vi.fn(() => null) });
    const call = vi.fn(async () => {
      throw new ConnectionLostError('primary reset');
    });

    await expect(recovery.run('query', call)).rejects.toThrow(/primary reset/);
    expect(deps.connect).not.toHaveBeenCalled();
    expect(deps.onLost).toHaveBeenCalledTimes(1);
  });

  it('recovers again after an earlier recovery finished', async () => {
    const { deps, recovery } = harness();
    const first = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new ConnectionLostError('primary reset'))
      .mockResolvedValueOnce('rows');
    const second = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new ConnectionLostError('primary reset again'))
      .mockResolvedValueOnce('more rows');

    await recovery.run('query', first);
    await recovery.run('query', second);
    expect(deps.connect).toHaveBeenCalledTimes(2);
  });
});
