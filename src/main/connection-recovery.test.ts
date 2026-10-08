import { ConnectionLostError } from '@shared/connection-loss';
import type { ConnectionConfig } from '@shared/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConnectionRecovery,
  NotReplayedError,
  type RecoveryDeps,
  type RetainedSession,
  isReplaySafeSql,
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
    epoch: vi.fn(() => 0),
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
    expect(recoveryPolicy('query', { kind: 'query', sql: 'SELECT * FROM t' })).toBe('retry');
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

  it('never replays user writes, transaction control or write commands (C5)', () => {
    expect(recoveryPolicy('query', { kind: 'query', sql: 'UPDATE t SET a = 1' })).toBe(
      'reconnect-only',
    );
    expect(recoveryPolicy('query')).toBe('reconnect-only');
    expect(
      recoveryPolicy('sidebandQuery', {
        kind: 'sidebandQuery',
        sql: 'SELECT pg_terminate_backend(1)',
      }),
    ).toBe('reconnect-only');
    expect(recoveryPolicy('beginTxn')).toBe('reconnect-only');
    expect(recoveryPolicy('commitTxn')).toBe('reconnect-only');
    expect(recoveryPolicy('rollbackTxn')).toBe('reconnect-only');
    // Safe Run is never replayed onto a fresh session.
    expect(recoveryPolicy('safeRunStart')).toBe('reconnect-only');
    expect(recoveryPolicy('safeRunFinish')).toBe('reconnect-only');
    expect(recoveryPolicy('safeRunUndoLast')).toBe('reconnect-only');
    expect(recoveryPolicy('redisCommand', { kind: 'redisCommand', parts: ['INCR', 'n'] })).toBe(
      'reconnect-only',
    );
    expect(recoveryPolicy('redisCommand', { kind: 'redisCommand', parts: ['GET', 'n'] })).toBe(
      'retry',
    );
    expect(recoveryPolicy('osSql')).toBe('reconnect-only');
  });

  it('replays Plasma lookups that run server-side READ ONLY, and EXPLAIN only without ANALYZE (SC-04)', () => {
    expect(
      recoveryPolicy('sidebandQuery', {
        kind: 'sidebandQuery',
        sql: 'SELECT f()',
        timeoutMs: 5000,
      }),
    ).toBe('retry');
    expect(recoveryPolicy('sidebandQuery', { kind: 'sidebandQuery', sql: 'SELECT f()' })).toBe(
      'reconnect-only',
    );
    expect(recoveryPolicy('explain', { kind: 'explain', sql: 'select 1', analyze: true })).toBe(
      'reconnect-only',
    );
    expect(recoveryPolicy('explain', { kind: 'explain', sql: 'select 1', analyze: false })).toBe(
      'retry',
    );
    expect(recoveryPolicy('query', { kind: 'query', sql: 'SELECT charge_customer(42)' })).toBe(
      'reconnect-only',
    );
  });
});

describe('isReplaySafeSql', () => {
  it.each([
    'SELECT 1',
    'select * from users where id = 1;',
    'WITH x AS (SELECT 1) SELECT * FROM x',
    'EXPLAIN SELECT 1',
    '-- comment\nSHOW search_path',
    "SELECT count(*), max(created_at), lower(name) FROM t WHERE id IN (1,2) AND x = 'a;b'",
    'SELECT * FROM generate_series(1, 3) AS g(n)',
    "SELECT date_trunc('day', now()), coalesce(a, 0), cast(b AS numeric(10,2)) FROM t",
    'SELECT sum(x) OVER (PARTITION BY y ORDER BY z) FROM t',
    'SELECT pg_catalog.count(*) FROM t WHERE note = $$call me(now)$$',
  ])('accepts %j', (sql) => {
    expect(isReplaySafeSql(sql)).toBe(true);
  });

  it.each([
    'UPDATE t SET a = 1',
    'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d',
    'EXPLAIN ANALYZE DELETE FROM t',
    'SELECT 1; DELETE FROM t',
    'SELECT * INTO copy FROM t',
    'SELECT * FROM t FOR UPDATE',
    "SELECT nextval('s')",
    'BEGIN',
    'COMMIT',
    'SET ROLE admin',
    '',
    // SC-04: functions that can't be proven pure are never replayed.
    'SELECT charge_customer(42)',
    "SELECT * FROM enqueue_job('x')",
    "SELECT pg_notify('c', 'p')",
    "SELECT setval('s', 10)",
    'SELECT public.count(*) FROM t',
    'SELECT "do_it"(1)',
    'SELECT lower(name), purge_old_orders() FROM t',
    'EXPLAIN (ANALYZE) SELECT 1',
    "SELECT 'unterminated",
  ])('refuses %j', (sql) => {
    expect(isReplaySafeSql(sql)).toBe(false);
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

    await expect(recovery.run('query', call, { kind: 'query', sql: 'SELECT 1' })).resolves.toBe(
      'rows',
    );
    expect(call).toHaveBeenCalledTimes(2);
    expect(deps.connect).toHaveBeenCalledTimes(1);
    expect(deps.onRecovered).toHaveBeenCalledWith(
      expect.objectContaining({ connectionGen: 7, connectionId: 'conn-1' }),
    );
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

    await expect(recovery.run('commitEditBatch', call)).rejects.toThrow(/not re-run/);
    expect(call).toHaveBeenCalledTimes(1);
    expect(deps.connect).toHaveBeenCalledTimes(1);
  });

  it('does not re-run a user UPDATE after the transport died mid-statement (C5)', async () => {
    const { deps, recovery } = harness();
    const call = vi.fn(async () => {
      throw new ConnectionLostError('connection terminated unexpectedly');
    });
    const err = await recovery
      .run('query', call, { kind: 'query', sql: 'UPDATE t SET a = 1' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotReplayedError);
    expect(String(err)).toMatch(/not re-run/);
    expect(call).toHaveBeenCalledTimes(1);
    expect(deps.connect).toHaveBeenCalledTimes(1);
  });

  it('never replays anything when the session died inside a transaction (C5)', async () => {
    const { recovery } = harness();
    const lost = Object.assign(new ConnectionLostError('primary reset'), { txnLost: true });
    const call = vi.fn(async () => {
      throw lost;
    });
    await expect(recovery.run('query', call, { kind: 'query', sql: 'SELECT 1' })).rejects.toThrow(
      /open transaction/,
    );
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('abandons a recovery when the user switched connection meanwhile (C11)', async () => {
    let epoch = 0;
    const { deps, recovery } = harness({
      epoch: vi.fn(() => epoch),
      session: vi.fn(() => ({ id: 'conn-1', config, tunnelled: true }) as RetainedSession | null),
      reopenTunnel: vi.fn(async () => {
        epoch = 1; // user clicked another connection while the tunnel reopened
        return { host: '127.0.0.1', port: 1 };
      }),
    });
    const call = vi.fn(async () => {
      throw new ConnectionLostError('primary reset');
    });
    await expect(recovery.run('query', call, { kind: 'query', sql: 'SELECT 1' })).rejects.toThrow(
      /primary reset/,
    );
    expect(deps.connect).not.toHaveBeenCalled();
    expect(deps.onRecovered).not.toHaveBeenCalled();
    expect(deps.onLost).not.toHaveBeenCalled();
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
      recovery.run('query', make(), { kind: 'query', sql: 'SELECT 1' }),
      recovery.run('introspect', make()),
      recovery.run('redisScan', make()),
    ]);

    expect(results).toEqual(['rows', 'rows', 'rows']);
    expect(deps.connect).toHaveBeenCalledTimes(1);
  });

  it('re-forwards the SSH tunnel before reconnecting a tunnelled session', async () => {
    const tunnelled: RetainedSession = { id: 'conn-1', config, tunnelled: true };
    const { deps, recovery } = harness({
      session: vi.fn(() => tunnelled as RetainedSession | null),
    });
    const call = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new ConnectionLostError('tunnel died'))
      .mockResolvedValueOnce('rows');

    await expect(recovery.run('query', call, { kind: 'query', sql: 'SELECT 1' })).resolves.toBe(
      'rows',
    );
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

    await recovery.run('query', first, { kind: 'query', sql: 'SELECT 1' });
    await recovery.run('query', second, { kind: 'query', sql: 'SELECT 1' });
    expect(deps.connect).toHaveBeenCalledTimes(2);
  });
});
