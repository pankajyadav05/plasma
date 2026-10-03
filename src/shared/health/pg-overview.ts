import {
  type CheckResult,
  type HealthFinding,
  type PgCheck,
  type Row,
  bool,
  fmtBytes,
  fmtDurationMs,
  fmtInt,
  fmtPct,
  num,
  numOrNull,
  str,
  worstStatus,
} from './types';

// ─── Cache hit ratio ─────────────────────────────────────────────────

export const CACHE_SQL = `
SELECT datname, blks_hit, blks_read FROM pg_stat_database WHERE datname = current_database()`;

export function interpretCache(rows: Row[]): CheckResult {
  const r = rows[0];
  const hit = num(r?.blks_hit);
  const read = num(r?.blks_read);
  const total = hit + read;
  if (!r || total < 1000) {
    return { status: 'ok', summary: 'Too little traffic to judge', findings: [] };
  }
  const ratio = (hit / total) * 100;
  const status = ratio < 90 ? 'crit' : ratio < 99 ? 'warn' : 'ok';
  const findings: HealthFinding[] =
    status === 'ok'
      ? []
      : [
          {
            id: 'cache-hit',
            status,
            title: `Buffer cache hit ratio is ${fmtPct(ratio)}`,
            evidence: `${fmtInt(hit)} hits vs ${fmtInt(read)} disk reads since stats reset. OLTP workloads should stay above 99%.`,
            action: {
              label: 'Review shared_buffers',
              note: 'Check shared_buffers (commonly 25% of RAM) and whether large scans evict hot pages. Hot tables and indexes are listed under Top queries and Indexes.',
            },
          },
        ];
  return { status, summary: `${fmtPct(ratio)} hit`, findings };
}

// ─── Connections ─────────────────────────────────────────────────────

export const CONNECTIONS_SQL = `
SELECT count(*)::int AS used,
       current_setting('max_connections')::int AS max_conn,
       current_setting('superuser_reserved_connections')::int AS reserved,
       count(*) FILTER (WHERE state = 'idle')::int AS idle,
       count(*) FILTER (WHERE state = 'active')::int AS active,
       count(*) FILTER (WHERE state LIKE 'idle in transaction%')::int AS idle_in_txn
FROM pg_stat_activity
WHERE backend_type = 'client backend'`;

export function interpretConnections(rows: Row[]): CheckResult {
  const r = rows[0];
  const used = num(r?.used);
  const max = Math.max(1, num(r?.max_conn, 100) - num(r?.reserved));
  const pct = (used / max) * 100;
  const status = pct >= 95 ? 'crit' : pct >= 80 ? 'warn' : 'ok';
  const findings: HealthFinding[] =
    status === 'ok'
      ? []
      : [
          {
            id: 'connections',
            status,
            title: `${used} of ${max} connections in use (${fmtPct(pct, 0)})`,
            evidence: `${num(r?.active)} active, ${num(r?.idle)} idle, ${num(r?.idle_in_txn)} idle in transaction. New clients are refused at the limit.`,
            action: {
              label: 'Use a pooler',
              note: 'Put PgBouncer (transaction mode) in front, close idle clients, or raise max_connections only after checking memory.',
            },
          },
        ];
  return { status, summary: `${used} / ${max} connections`, findings };
}

// ─── Database sizes and largest tables ───────────────────────────────

export const DB_SIZES_SQL = `
SELECT datname, pg_database_size(oid) AS size_bytes
FROM pg_database
WHERE datallowconn AND NOT datistemplate
ORDER BY 2 DESC
LIMIT 20`;

export function interpretDbSizes(rows: Row[]): CheckResult {
  const total = rows.reduce((a, r) => a + num(r.size_bytes), 0);
  return {
    status: 'ok',
    summary: `${rows.length} database${rows.length === 1 ? '' : 's'}, ${fmtBytes(total)}`,
    findings: [],
    table: {
      columns: [
        { key: 'db', label: 'Database', width: 260 },
        { key: 'size', label: 'Size', align: 'right', width: 120 },
      ],
      rows: rows.map((r) => ({ db: str(r.datname), size: fmtBytes(num(r.size_bytes)) })),
    },
  };
}

export const LARGEST_TABLES_SQL = `
SELECT schemaname AS schema_name, relname AS table_name,
       pg_total_relation_size(relid) AS total_bytes,
       pg_relation_size(relid) AS heap_bytes,
       pg_indexes_size(relid) AS index_bytes,
       n_live_tup
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC
LIMIT 15`;

export function interpretLargestTables(rows: Row[]): CheckResult {
  return {
    status: 'ok',
    summary: rows[0]
      ? `Largest: ${str(rows[0].table_name)} (${fmtBytes(num(rows[0].total_bytes))})`
      : 'No user tables',
    findings: [],
    table: {
      columns: [
        { key: 'table', label: 'Table', width: 260 },
        { key: 'total', label: 'Total', align: 'right', width: 100 },
        { key: 'heap', label: 'Heap', align: 'right', width: 100 },
        { key: 'indexes', label: 'Indexes', align: 'right', width: 100 },
        { key: 'rows', label: 'Live rows', align: 'right', width: 110 },
      ],
      rows: rows.map((r) => ({
        table: `${str(r.schema_name)}.${str(r.table_name)}`,
        total: fmtBytes(num(r.total_bytes)),
        heap: fmtBytes(num(r.heap_bytes)),
        indexes: fmtBytes(num(r.index_bytes)),
        rows: fmtInt(num(r.n_live_tup)),
      })),
    },
  };
}

// ─── Replication slots and lag ───────────────────────────────────────

export const SLOTS_SQL = `
SELECT slot_name, slot_type, active, wal_status,
       CASE WHEN restart_lsn IS NULL THEN NULL
            WHEN pg_is_in_recovery() THEN pg_wal_lsn_diff(pg_last_wal_replay_lsn(), restart_lsn)
            ELSE pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) END AS retained_bytes
FROM pg_replication_slots
ORDER BY 5 DESC NULLS LAST`;

const SLOT_CRIT_BYTES = 10 * 1024 ** 3;

export function interpretSlots(rows: Row[]): CheckResult {
  const findings: HealthFinding[] = [];
  for (const r of rows) {
    const name = str(r.slot_name);
    const retained = numOrNull(r.retained_bytes);
    const active = bool(r.active);
    const lost = str(r.wal_status) === 'lost';
    if (!active || lost) {
      const big = retained !== null && retained >= SLOT_CRIT_BYTES;
      findings.push({
        id: `slot:${name}`,
        status: lost || big ? 'crit' : 'warn',
        title: lost ? `Slot ${name} has lost WAL` : `Slot ${name} is inactive and retaining WAL`,
        evidence: `${str(r.slot_type)} slot, ${retained === null ? 'no restart_lsn' : `${fmtBytes(retained)} of WAL retained`}. An inactive slot makes pg_wal grow until the disk fills.`,
        action: {
          label: 'Drop slot',
          sql: `SELECT pg_drop_replication_slot('${name.replace(/'/g, "''")}');`,
          destructive: true,
        },
      });
    } else if (retained !== null && retained >= SLOT_CRIT_BYTES) {
      findings.push({
        id: `slot:${name}`,
        status: 'warn',
        title: `Slot ${name} is ${fmtBytes(retained)} behind`,
        evidence: 'The consumer is connected but not keeping up; WAL accumulates meanwhile.',
      });
    }
  }
  return {
    status: worstStatus(findings.map((f) => f.status)),
    summary:
      rows.length === 0
        ? 'No replication slots'
        : `${rows.length} slot(s), ${findings.length} issue(s)`,
    findings,
  };
}

export const REPLICATION_SQL = `
SELECT application_name, client_addr::text AS client_addr, state, sync_state,
       CASE WHEN pg_is_in_recovery() THEN NULL ELSE pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) END AS lag_bytes,
       extract(epoch FROM replay_lag) AS replay_lag_s
FROM pg_stat_replication
ORDER BY 5 DESC NULLS LAST`;

export function interpretReplication(rows: Row[]): CheckResult {
  const findings: HealthFinding[] = [];
  for (const r of rows) {
    const bytes = numOrNull(r.lag_bytes);
    const secs = numOrNull(r.replay_lag_s);
    const bad = (secs !== null && secs > 60) || (bytes !== null && bytes > 256 * 1024 * 1024);
    const crit = (secs !== null && secs > 600) || (bytes !== null && bytes > 4 * 1024 ** 3);
    if (!bad && str(r.state) === 'streaming') continue;
    findings.push({
      id: `repl:${str(r.application_name)}:${str(r.client_addr)}`,
      status: crit ? 'crit' : 'warn',
      title: `Standby ${str(r.application_name) || str(r.client_addr)} is ${str(r.state)}`,
      evidence: `Replay lag ${secs === null ? 'unknown' : fmtDurationMs(secs * 1000)}, ${bytes === null ? 'unknown' : fmtBytes(bytes)} behind.`,
    });
  }
  return {
    status: worstStatus(findings.map((f) => f.status)),
    summary: rows.length === 0 ? 'No standbys attached' : `${rows.length} standby(s)`,
    findings,
    table: rows.length
      ? {
          columns: [
            { key: 'name', label: 'Standby', width: 200 },
            { key: 'state', label: 'State', width: 110 },
            { key: 'sync', label: 'Sync', width: 90 },
            { key: 'lag', label: 'Lag (bytes)', align: 'right', width: 120 },
            { key: 'replay', label: 'Replay lag', align: 'right', width: 110 },
          ],
          rows: rows.map((r) => {
            const b = numOrNull(r.lag_bytes);
            const s = numOrNull(r.replay_lag_s);
            return {
              name: str(r.application_name) || str(r.client_addr),
              state: str(r.state),
              sync: str(r.sync_state),
              lag: b === null ? '—' : fmtBytes(b),
              replay: s === null ? '—' : fmtDurationMs(s * 1000),
            };
          }),
        }
      : undefined,
  };
}

// ─── Long-running and idle-in-transaction sessions ───────────────────

/** $1 = long-running seconds, $2 = idle-in-transaction seconds. */
export const LONG_SESSIONS_SQL = `
SELECT pid, usename AS user_name, datname, state, application_name,
       extract(epoch FROM (clock_timestamp() - CASE WHEN state = 'active' THEN query_start ELSE state_change END)) AS age_s,
       xact_start IS NOT NULL AS in_txn,
       left(query, 400) AS query
FROM pg_stat_activity
WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()
  AND (
    (state = 'active' AND clock_timestamp() - query_start > make_interval(secs => $1::int))
    OR (state LIKE 'idle in transaction%' AND clock_timestamp() - state_change > make_interval(secs => $2::int))
  )
ORDER BY age_s DESC
LIMIT 50`;

export const LONG_RUNNING_SECONDS = 300;
export const IDLE_IN_TXN_SECONDS = 60;

export function interpretLongSessions(rows: Row[]): CheckResult {
  const findings: HealthFinding[] = rows.map((r) => {
    const pid = num(r.pid);
    const idle = str(r.state).startsWith('idle in transaction');
    const age = num(r.age_s);
    return {
      id: `sess:${pid}`,
      status: idle ? (age >= 600 ? 'crit' : 'warn') : age >= 1800 ? 'crit' : 'warn',
      title: idle
        ? `pid ${pid} (${str(r.user_name)}) idle in transaction for ${fmtDurationMs(age * 1000)}`
        : `pid ${pid} (${str(r.user_name)}) has run a query for ${fmtDurationMs(age * 1000)}`,
      evidence: `${str(r.application_name) || 'unknown app'} on ${str(r.datname)}. ${
        idle ? 'It holds locks and an old snapshot, which blocks vacuum and DDL. ' : ''
      }${str(r.query).replace(/\s+/g, ' ').slice(0, 200)}`,
      action: idle
        ? {
            label: 'Terminate session',
            sql: `SELECT pg_terminate_backend(${pid});`,
            destructive: true,
          }
        : { label: 'Cancel query', sql: `SELECT pg_cancel_backend(${pid});`, destructive: true },
    };
  });
  return {
    status: worstStatus(findings.map((f) => f.status)),
    summary: findings.length ? `${findings.length} long / idle-in-txn` : 'No long sessions',
    findings,
  };
}

export const PG_OVERVIEW_CHECKS: PgCheck[] = [
  {
    id: 'ov-cache',
    section: 'overview',
    title: 'Cache hit ratio',
    sql: CACHE_SQL,
    interpret: interpretCache,
  },
  {
    id: 'ov-connections',
    section: 'overview',
    title: 'Connections',
    sql: CONNECTIONS_SQL,
    interpret: interpretConnections,
  },
  {
    id: 'ov-sessions',
    section: 'overview',
    title: 'Long-running and idle-in-transaction sessions',
    sql: LONG_SESSIONS_SQL,
    params: [LONG_RUNNING_SECONDS, IDLE_IN_TXN_SECONDS],
    interpret: interpretLongSessions,
  },
  {
    id: 'ov-slots',
    section: 'overview',
    title: 'Replication slots',
    sql: SLOTS_SQL,
    interpret: interpretSlots,
  },
  {
    id: 'ov-replication',
    section: 'overview',
    title: 'Replication lag',
    sql: REPLICATION_SQL,
    interpret: interpretReplication,
  },
  {
    id: 'ov-dbsizes',
    section: 'overview',
    title: 'Database sizes',
    sql: DB_SIZES_SQL,
    interpret: interpretDbSizes,
  },
  {
    id: 'ov-tables',
    section: 'overview',
    title: 'Largest tables',
    sql: LARGEST_TABLES_SQL,
    interpret: interpretLargestTables,
  },
];
