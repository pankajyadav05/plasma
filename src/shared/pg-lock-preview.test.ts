import { describe, expect, it } from 'vitest';
import {
  LOCK_CONTEXT_SQL,
  analyzeLocks,
  describeLockTarget,
  humanBytes,
  humanRows,
  lockBlocks,
  lockTargetNames,
  parseLockContext,
} from './pg-lock-preview';

const one = (sql: string) => {
  const l = analyzeLocks(sql);
  expect(l).toHaveLength(1);
  return l[0]!;
};

describe('static lock table', () => {
  it('maps modes to what they block', () => {
    expect(lockBlocks('ACCESS EXCLUSIVE')).toBe('reads and writes');
    expect(lockBlocks('SHARE')).toBe('writes');
    expect(lockBlocks('SHARE ROW EXCLUSIVE')).toBe('writes');
    expect(lockBlocks('SHARE UPDATE EXCLUSIVE')).toBe('nothing');
    expect(lockBlocks('ROW EXCLUSIVE')).toBe('nothing');
  });
  it('ALTER TABLE defaults to ACCESS EXCLUSIVE', () => {
    const l = one('ALTER TABLE public.orders ADD COLUMN x int');
    expect(l.mode).toBe('ACCESS EXCLUSIVE');
    expect(l.blocks).toBe('reads and writes');
    expect(l.targets[0]).toMatchObject({ raw: 'public.orders', display: 'public.orders' });
  });
  it('ADD FOREIGN KEY takes SHARE ROW EXCLUSIVE on both tables', () => {
    const l = one('ALTER TABLE orders ADD FOREIGN KEY (c) REFERENCES customers (id)');
    expect(l.mode).toBe('SHARE ROW EXCLUSIVE');
    expect(l.targets.map((t) => [t.display, t.mode])).toEqual([
      ['orders', 'SHARE ROW EXCLUSIVE'],
      ['customers', 'SHARE ROW EXCLUSIVE'],
    ]);
  });
  it('VALIDATE CONSTRAINT / SET (storage) / SET STATISTICS are SHARE UPDATE EXCLUSIVE', () => {
    expect(one('ALTER TABLE t VALIDATE CONSTRAINT c').mode).toBe('SHARE UPDATE EXCLUSIVE');
    expect(one('ALTER TABLE t SET (autovacuum_enabled = false)').mode).toBe(
      'SHARE UPDATE EXCLUSIVE',
    );
    expect(one('ALTER TABLE t ALTER COLUMN a SET STATISTICS 100').mode).toBe(
      'SHARE UPDATE EXCLUSIVE',
    );
  });
  it('takes the strongest lock across comma-separated actions', () => {
    expect(one('ALTER TABLE t VALIDATE CONSTRAINT c, DROP COLUMN x').mode).toBe('ACCESS EXCLUSIVE');
  });
  it('CREATE INDEX is SHARE, CONCURRENTLY is SHARE UPDATE EXCLUSIVE', () => {
    expect(one('CREATE INDEX i ON t (a)').mode).toBe('SHARE');
    expect(one('CREATE UNIQUE INDEX CONCURRENTLY i ON ONLY s.t (a)').mode).toBe(
      'SHARE UPDATE EXCLUSIVE',
    );
  });
  it('DROP INDEX targets the index; DROP TABLE / TRUNCATE are ACCESS EXCLUSIVE', () => {
    const d = one('DROP INDEX IF EXISTS public.idx_a');
    expect(d.targets[0]).toMatchObject({ kind: 'index', mode: 'ACCESS EXCLUSIVE' });
    expect(one('DROP INDEX CONCURRENTLY idx_a').mode).toBe('SHARE UPDATE EXCLUSIVE');
    expect(one('DROP TABLE IF EXISTS a, b').targets).toHaveLength(2);
    const t = one('TRUNCATE TABLE a, b RESTART IDENTITY CASCADE');
    expect(t.targets.map((x) => x.display)).toEqual(['a', 'b']);
    expect(t.mode).toBe('ACCESS EXCLUSIVE');
  });
  it('VACUUM / VACUUM FULL / CLUSTER / REINDEX', () => {
    expect(one('VACUUM (ANALYZE) t').mode).toBe('SHARE UPDATE EXCLUSIVE');
    expect(one('VACUUM FULL t').mode).toBe('ACCESS EXCLUSIVE');
    expect(one('VACUUM (FULL, VERBOSE) t').mode).toBe('ACCESS EXCLUSIVE');
    expect(one('CLUSTER t USING i').mode).toBe('ACCESS EXCLUSIVE');
    expect(one('REINDEX TABLE t').mode).toBe('SHARE');
    expect(one('REINDEX TABLE CONCURRENTLY t').mode).toBe('SHARE UPDATE EXCLUSIVE');
  });
  it('LOCK TABLE honours the IN … MODE clause', () => {
    expect(one('LOCK TABLE t').mode).toBe('ACCESS EXCLUSIVE');
    expect(one('LOCK t IN SHARE ROW EXCLUSIVE MODE').mode).toBe('SHARE ROW EXCLUSIVE');
    expect(one('LOCK TABLE a, b IN ROW SHARE MODE').targets).toHaveLength(2);
  });
  it('DML takes ROW EXCLUSIVE; CREATE TABLE / roles take nothing on existing tables', () => {
    expect(one('INSERT INTO t VALUES (1)').mode).toBe('ROW EXCLUSIVE');
    expect(one('UPDATE t SET a = 1').mode).toBe('ROW EXCLUSIVE');
    expect(one('DELETE FROM t').mode).toBe('ROW EXCLUSIVE');
    expect(analyzeLocks('CREATE TABLE n (a int)')).toEqual([]);
    expect(analyzeLocks('CREATE ROLE r LOGIN; GRANT SELECT ON t TO r')).toEqual([]);
  });
  it('CREATE TABLE … REFERENCES locks the referenced table', () => {
    const l = one('CREATE TABLE c (id int, p int REFERENCES parent (id))');
    expect(l.targets[0]).toMatchObject({ display: 'parent', mode: 'SHARE ROW EXCLUSIVE' });
  });
  it('attaches indices per statement and lists distinct target names', () => {
    const locks = analyzeLocks(
      'SELECT 1; ALTER TABLE a DROP COLUMN x; ALTER TABLE a ADD y int; DROP TABLE b',
    );
    expect(locks.map((l) => l.statementIndex)).toEqual([1, 2, 3]);
    expect(lockTargetNames(locks)).toEqual(['a', 'b']);
  });
  it('ignores keywords hidden in strings and comments', () => {
    expect(analyzeLocks("-- DROP TABLE a\nSELECT 'TRUNCATE b'")).toEqual([]);
  });
});

describe('formatting', () => {
  it('humanises rows and bytes', () => {
    expect(humanRows(1_200_000)).toBe('1.2M');
    expect(humanRows(12_345)).toBe('12k');
    expect(humanRows(842)).toBe('842');
    expect(humanBytes(340 * 1024 * 1024)).toBe('340 MB');
    expect(humanBytes(900)).toBe('900 B');
  });
  it('describes a lock with live context', () => {
    const lock = one('ALTER TABLE public.orders ADD COLUMN x int');
    const ctx = parseLockContext([
      {
        name: 'public.orders',
        resolved: 'public.orders',
        relkind: 'r',
        est_rows: '1200000',
        total_bytes: String(340 * 1024 * 1024),
        session_count: 3,
        holders: 3,
        waiters: 0,
        sessions: [
          { pid: 1, user: 'u', state: 'active', modes: 'RowExclusiveLock', waiting: false },
        ],
        columns: [{ name: 'id', type: 'integer' }],
        indexes: [['id']],
      },
    ]);
    const line = describeLockTarget(lock, lock.targets[0]!, ctx.get('public.orders'));
    expect(line.text).toBe(
      'This ALTER takes ACCESS EXCLUSIVE on public.orders (≈1.2M rows, 340 MB); 3 sessions are using it now.',
    );
    expect(line.blocks).toBe('reads and writes');
    expect(ctx.get('public.orders')?.indexes).toEqual([['id']]);
  });
  it('describes without context, idle tables and missing relations', () => {
    const lock = one('DROP TABLE t');
    expect(describeLockTarget(lock, lock.targets[0]!).text).toBe(
      'This DROP takes ACCESS EXCLUSIVE on t.',
    );
    const idle = parseLockContext([
      { name: 't', resolved: 'public.t', est_rows: null, session_count: 0 },
    ]).get('t');
    expect(describeLockTarget(lock, lock.targets[0]!, idle).text).toContain(
      'no other session is using it now',
    );
    const gone = parseLockContext([{ name: 't', resolved: null }]).get('t');
    expect(describeLockTarget(lock, lock.targets[0]!, gone).text).toContain('not found');
    const waiting = parseLockContext([
      { name: 't', resolved: 'public.t', session_count: 1, waiters: 1 },
    ]).get('t');
    expect(describeLockTarget(lock, lock.targets[0]!, waiting).text).toContain(
      '1 session is using it now (1 waiting)',
    );
  });
  it('context SQL is a read-only single statement', () => {
    expect(LOCK_CONTEXT_SQL).toMatch(/^\s*WITH /);
    expect(LOCK_CONTEXT_SQL).not.toMatch(/\b(insert|update|delete|drop)\b/i);
  });
});
