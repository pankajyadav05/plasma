import { describe, expect, it } from 'vitest';
import {
  IDLE_LIFECYCLE,
  classifyFailure,
  endsTransaction,
  holdsPrimary,
  reduceLifecycle,
} from './query-lifecycle';

const TXN_LOST =
  'Connection lost during an open transaction — the transaction was rolled back by the server and nothing was re-run. (x)';

describe('review fixes: lifecycle rules', () => {
  it('P1-2: a COMMIT whose reply was lost is unknown even when the message says rolled back', () => {
    const c = classifyFailure(TXN_LOST, { isWrite: true, commitLike: true });
    expect(c.phase).toBe('unknown');
    expect(c.message).not.toMatch(/rolled back/);
    expect(classifyFailure('connection terminated', { commitLike: true }).phase).toBe('unknown');
  });

  it('P1-2: without a COMMIT in flight the same message is a certain rollback', () => {
    expect(classifyFailure(TXN_LOST, { isWrite: true }).phase).toBe('disconnected');
  });

  it('P1-2: endsTransaction knows COMMIT, END, chained and prepared forms', () => {
    for (const sql of [
      'COMMIT',
      'commit;',
      'COMMIT AND CHAIN',
      'END',
      'end transaction',
      "COMMIT PREPARED 'x'",
      "PREPARE TRANSACTION 'x'",
      '/* c */ -- note\nCOMMIT',
    ]) {
      expect(endsTransaction(sql)).toBe(true);
    }
    for (const sql of ['select 1', 'UPDATE t SET commit = 1', 'BEGIN', 'rollback']) {
      expect(endsTransaction(sql)).toBe(false);
    }
    const l = reduceLifecycle(
      { phase: 'running', since: 1, startedAt: 1 },
      { type: 'fail', now: 2, message: TXN_LOST, isWrite: true, commitLike: true, sql: 'COMMIT' },
    );
    expect(l).toMatchObject({ phase: 'unknown', sql: 'COMMIT' });
  });

  it('P1-4: only primary-lane runs hold the primary connection', () => {
    const running = { phase: 'running' as const, since: 1 };
    expect(holdsPrimary(running)).toBe(true);
    expect(holdsPrimary({ ...running, phase: 'cancelling' })).toBe(true);
    expect(holdsPrimary({ ...running, aux: true })).toBe(false);
    expect(holdsPrimary({ ...running, phase: 'queued' })).toBe(false);
    expect(holdsPrimary(IDLE_LIFECYCLE)).toBe(false);
    expect(holdsPrimary(undefined)).toBe(false);
  });
});
