import { describe, expect, it } from 'vitest';
import {
  PG_OVERVIEW_CHECKS,
  interpretCache,
  interpretConnections,
  interpretDbSizes,
  interpretLargestTables,
  interpretLongSessions,
  interpretReplication,
  interpretSlots,
} from './pg-overview';

const GB = 1024 ** 3;

describe('cache and connections', () => {
  it('grades the hit ratio', () => {
    expect(interpretCache([{ blks_hit: 90, blks_read: 5 }]).summary).toContain('Too little');
    expect(interpretCache([{ blks_hit: 999_000, blks_read: 1000 }]).status).toBe('ok');
    expect(interpretCache([{ blks_hit: 95_000, blks_read: 5000 }]).status).toBe('warn');
    expect(interpretCache([{ blks_hit: 80_000, blks_read: 20_000 }]).status).toBe('crit');
  });

  it('grades connection usage against max_connections minus reserved', () => {
    const row = (used: number) => [
      { used, max_conn: 100, reserved: 3, idle: 0, active: used, idle_in_txn: 0 },
    ];
    expect(interpretConnections(row(10)).status).toBe('ok');
    expect(interpretConnections(row(80)).status).toBe('warn');
    expect(interpretConnections(row(95)).status).toBe('crit');
    expect(interpretConnections(row(10)).summary).toBe('10 / 97 connections');
  });
});

describe('sizes', () => {
  it('lists databases and largest tables', () => {
    expect(interpretDbSizes([{ datname: 'a', size_bytes: GB }]).table?.rows[0]).toEqual({
      db: 'a',
      size: '1.0 GiB',
    });
    const r = interpretLargestTables([
      {
        schema_name: 'public',
        table_name: 'big',
        total_bytes: 2 * GB,
        heap_bytes: GB,
        index_bytes: GB,
        n_live_tup: 5,
      },
    ]);
    expect(r.summary).toContain('big');
  });
});

describe('replication', () => {
  it('flags an inactive slot retaining WAL with a drop preview', () => {
    const r = interpretSlots([
      {
        slot_name: 'old',
        slot_type: 'logical',
        active: false,
        wal_status: 'reserved',
        retained_bytes: 20 * GB,
      },
    ]);
    expect(r.status).toBe('crit');
    expect(r.findings[0]?.action?.sql).toBe("SELECT pg_drop_replication_slot('old');");
  });

  it('is calm for an active, current slot', () => {
    expect(
      interpretSlots([
        {
          slot_name: 's',
          slot_type: 'physical',
          active: true,
          wal_status: 'reserved',
          retained_bytes: 1000,
        },
      ]).status,
    ).toBe('ok');
    expect(interpretSlots([]).summary).toBe('No replication slots');
  });

  it('grades standby lag', () => {
    expect(interpretReplication([]).summary).toBe('No standbys attached');
    expect(
      interpretReplication([
        { application_name: 's1', state: 'streaming', lag_bytes: 10, replay_lag_s: 0.1 },
      ]).status,
    ).toBe('ok');
    expect(
      interpretReplication([
        { application_name: 's1', state: 'streaming', lag_bytes: 5 * GB, replay_lag_s: 700 },
      ]).status,
    ).toBe('crit');
    expect(
      interpretReplication([
        { application_name: 's1', state: 'catchup', lag_bytes: 10, replay_lag_s: 1 },
      ]).status,
    ).toBe('warn');
  });
});

describe('long sessions', () => {
  it('offers terminate for idle-in-transaction and cancel for long queries', () => {
    const r = interpretLongSessions([
      {
        pid: 11,
        user_name: 'app',
        datname: 'db',
        state: 'idle in transaction',
        application_name: 'api',
        age_s: 900,
        query: 'UPDATE x',
      },
      {
        pid: 12,
        user_name: 'app',
        datname: 'db',
        state: 'active',
        application_name: 'report',
        age_s: 400,
        query: 'SELECT slow',
      },
    ]);
    expect(r.findings[0]?.action?.sql).toBe('SELECT pg_terminate_backend(11);');
    expect(r.findings[0]?.status).toBe('crit');
    expect(r.findings[1]?.action?.sql).toBe('SELECT pg_cancel_backend(12);');
    expect(r.findings[1]?.status).toBe('warn');
  });

  it('passes thresholds as parameters', () => {
    const c = PG_OVERVIEW_CHECKS.find((x) => x.id === 'ov-sessions');
    expect(c?.params).toEqual([300, 60]);
  });
});
