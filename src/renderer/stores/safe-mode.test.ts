import { describe, expect, it } from 'vitest';
import { effectiveSafeMode, safeModeDecision } from './safe-mode';

const d = (
  sql: string,
  level: Parameters<typeof safeModeDecision>[0]['level'],
  prodTagged = false,
  force = false,
) => safeModeDecision({ sql, level, prodTagged, force }).kind;

describe('safeModeDecision', () => {
  it('off runs everything, prod still confirms destructive', () => {
    expect(d('delete from t', 'off')).toBe('run');
    expect(d('delete from t', 'off', true)).toBe('confirm');
    expect(d('select 1', 'off', true)).toBe('run');
  });
  it('confirm-dangerous asks only for destructive statements', () => {
    expect(d('select 1', 'confirm-dangerous')).toBe('run');
    expect(d('drop table t', 'confirm-dangerous')).toBe('confirm');
  });
  it('confirm-writes asks for writes but not reads or session statements', () => {
    expect(d('select 1', 'confirm-writes')).toBe('run');
    expect(d('set search_path = x', 'confirm-writes')).toBe('run');
    expect(d('insert into t values (1)', 'confirm-writes')).toBe('confirm');
  });
  it('confirm-all asks for every statement', () => {
    expect(d('select 1', 'confirm-all')).toBe('confirm');
    expect(d('', 'confirm-all', false, true)).toBe('confirm');
  });
  it('read-only refuses writes and lets reads through', () => {
    expect(d('update t set a = 1', 'read-only')).toBe('refuse');
    expect(d('select 1', 'read-only')).toBe('run');
    expect(d('begin', 'read-only')).toBe('run');
    expect(d('', 'read-only', false, true)).toBe('refuse');
  });
  it('reports the reason', () => {
    expect(safeModeDecision({ sql: 'drop table t', level: 'off', prodTagged: true })).toMatchObject(
      { reason: 'prod' },
    );
    expect(
      safeModeDecision({ sql: 'select 1', level: 'confirm-all', prodTagged: false }),
    ).toMatchObject({ reason: 'safe-mode' });
  });
});

describe('safeModeDecision: side-effect SELECTs (SC-13)', () => {
  it('read-only asks before a SELECT that calls a function it cannot vouch for', () => {
    expect(d('select purge_old_orders()', 'read-only')).toBe('confirm');
    expect(d('select app.close_month(3)', 'read-only')).toBe('confirm');
    expect(d('select * from refresh_things()', 'read-only')).toBe('confirm');
    expect(d('select "Do_It"()', 'read-only')).toBe('confirm');
  });

  it('read-only refuses known state-changing functions outright', () => {
    expect(d("select nextval('s')", 'read-only')).toBe('refuse');
    expect(d('select pg_terminate_backend(123)', 'read-only')).toBe('refuse');
    expect(d("select setval('s', 1)", 'read-only')).toBe('refuse');
    expect(d("select set_config('a','b',false)", 'read-only')).toBe('refuse');
    expect(d('select pg_advisory_lock(1)', 'read-only')).toBe('refuse');
  });

  it('read-only refuses SELECT … FOR UPDATE / FOR SHARE (locking reads)', () => {
    expect(d('select * from t for update', 'read-only')).toBe('refuse');
    expect(d('select * from t where id = 1 for no key update', 'read-only')).toBe('refuse');
    expect(d('select * from t for share', 'read-only')).toBe('refuse');
  });

  it('read-only still runs ordinary reads that use built-in functions', () => {
    for (const sql of [
      'select count(*) from t',
      'select lower(email), now(), coalesce(a, 0) from t where id in (1, 2) and x = any(array[1,2])',
      'select * from t order by created_at limit 10',
      'with x as (select 1) select * from x',
      "select date_trunc('day', ts), jsonb_agg(a) over (partition by b) from t",
      'select * from generate_series(1, 10)',
      'select st_astext(geom) from places',
      'explain select purge_old_orders()',
      'show search_path',
    ]) {
      expect(d(sql, 'read-only')).toBe('run');
    }
  });

  it('read-only refuses session statements that undo read-only', () => {
    expect(d('set default_transaction_read_only = off', 'read-only')).toBe('refuse');
    expect(d('reset all', 'read-only')).toBe('refuse');
    expect(d('set session characteristics as transaction read write', 'read-only')).toBe('refuse');
    expect(d('set search_path = x', 'read-only')).toBe('run');
    expect(d('set role analyst', 'read-only')).toBe('run');
  });

  it('other levels treat nextval()/pg_terminate_backend() as writes, not plain reads', () => {
    expect(d("select nextval('s')", 'confirm-writes')).toBe('confirm');
    expect(d('select purge_old_orders()', 'confirm-writes')).toBe('run');
    expect(d('select purge_old_orders()', 'off')).toBe('run');
  });
});

describe('effectiveSafeMode', () => {
  it('prefers the connection override over the default', () => {
    const s = { safeModeDefault: 'off' as const, connectionSafeMode: { a: 'read-only' as const } };
    expect(effectiveSafeMode(s, 'a')).toBe('read-only');
    expect(effectiveSafeMode(s, 'b')).toBe('off');
    expect(effectiveSafeMode(undefined, null)).toBe('confirm-dangerous');
  });
});
