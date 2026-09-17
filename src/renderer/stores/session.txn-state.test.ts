import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const queryRun = vi.fn();

vi.mock('@/lib/ipc', () => ({
  ipc: {
    query: {
      run: (...args: unknown[]) => queryRun(...args),
      cancel: vi.fn(async () => undefined),
    },
    sql: { format: vi.fn() },
    conn: {
      test: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      introspect: vi.fn(),
    },
    settings: { get: vi.fn(), set: vi.fn(async () => undefined) },
    history: { list: vi.fn(async () => []), clear: vi.fn() },
    txn: { begin: vi.fn(), commit: vi.fn(), rollback: vi.fn() },
    ai: { chat: vi.fn(), cancel: vi.fn() },
  },
}));

import { useSession } from './session';

/**
 * U44 — main pushes the primary session's transaction state over
 * `plasma:txn:state`; the store mirrors it for the status bar.
 */
describe('session transaction state mirroring', () => {
  beforeEach(() => {
    useSession.setState({ txnState: 'none' });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('handleTxnState adopts the pushed state', () => {
    useSession.getState().handleTxnState('active');
    expect(useSession.getState().txnState).toBe('active');

    useSession.getState().handleTxnState('error');
    expect(useSession.getState().txnState).toBe('error');

    useSession.getState().handleTxnState('none');
    expect(useSession.getState().txnState).toBe('none');
  });

  it('handleConnectionRecovered resets the transaction state', () => {
    useSession.getState().handleTxnState('error');
    useSession.getState().handleConnectionRecovered({
      serverVersion: 'PostgreSQL 16.6',
      engine: 'postgres',
      connectionGen: 9,
      attempts: 1,
    });
    expect(useSession.getState().txnState).toBe('none');
    expect(useSession.getState().connectionGen).toBe(9);
  });
});
