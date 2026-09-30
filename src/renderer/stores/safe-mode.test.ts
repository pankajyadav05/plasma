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

describe('effectiveSafeMode', () => {
  it('prefers the connection override over the default', () => {
    const s = { safeModeDefault: 'off' as const, connectionSafeMode: { a: 'read-only' as const } };
    expect(effectiveSafeMode(s, 'a')).toBe('read-only');
    expect(effectiveSafeMode(s, 'b')).toBe('off');
    expect(effectiveSafeMode(undefined, null)).toBe('confirm-dangerous');
  });
});
