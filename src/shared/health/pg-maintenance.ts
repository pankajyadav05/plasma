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
  qualified,
  str,
  worstStatus,
} from './types';

const SYSTEM_SCHEMAS = `('pg_catalog','information_schema','pg_toast')`;

// ─── Table bloat (statistical estimate) ──────────────────────────────

/**
 * The widely used statistical estimate (after ioguix/pgsql-bloat-estimation):
 * expected pages from pg_stats row widths versus actual relpages. It is an
 * estimate; tables that were never ANALYZEd or use exotic types are skipped.
 */
export const TABLE_BLOAT_SQL = `
SELECT schema_name, table_name, bs * tblpages AS real_size,
       bs * greatest(tblpages - est_tblpages_ff, 0) AS bloat_size,
       CASE WHEN tblpages > 0 AND tblpages - est_tblpages_ff > 0
            THEN 100 * (tblpages - est_tblpages_ff) / tblpages::float ELSE 0 END AS bloat_pct
FROM (
  SELECT ceil(reltuples / ((bs - page_hdr) * fillfactor / (tpl_size * 100))) + ceil(toasttuples / 4) AS est_tblpages_ff,
         tblpages, bs, schema_name, table_name
  FROM (
    SELECT (4 + tpl_hdr_size + tpl_data_size + (2 * ma)
              - CASE WHEN tpl_hdr_size % ma = 0 THEN ma ELSE tpl_hdr_size % ma END
              - CASE WHEN ceil(tpl_data_size)::int % ma = 0 THEN ma ELSE ceil(tpl_data_size)::int % ma END
           ) AS tpl_size,
           (heappages + toastpages) AS tblpages, reltuples, toasttuples, bs, page_hdr,
           schema_name, table_name, fillfactor
    FROM (
      SELECT ns.nspname AS schema_name, tbl.relname AS table_name, tbl.reltuples,
             tbl.relpages AS heappages, coalesce(toast.relpages, 0) AS toastpages,
             coalesce(toast.reltuples, 0) AS toasttuples,
             coalesce(substring(array_to_string(tbl.reloptions, ' ') FROM 'fillfactor=([0-9]+)')::smallint, 100) AS fillfactor,
             current_setting('block_size')::numeric AS bs,
             CASE WHEN version() ~ 'mingw32' OR version() ~ '64-bit|x86_64|ppc64|ia64|amd64' THEN 8 ELSE 4 END AS ma,
             24 AS page_hdr,
             23 + CASE WHEN max(coalesce(s.null_frac, 0)) > 0 THEN (7 + count(s.attname)) / 8 ELSE 0::int END AS tpl_hdr_size,
             sum((1 - coalesce(s.null_frac, 0)) * coalesce(s.avg_width, 0)) AS tpl_data_size,
             bool_or(att.atttypid = 'pg_catalog.name'::regtype)
               OR count(att.attnum) <> count(s.attname) AS is_na
      FROM pg_attribute att
      JOIN pg_class tbl ON att.attrelid = tbl.oid
      JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
      LEFT JOIN pg_stats s ON s.schemaname = ns.nspname AND s.tablename = tbl.relname
                          AND s.inherited = false AND s.attname = att.attname
      LEFT JOIN pg_class toast ON tbl.reltoastrelid = toast.oid
      WHERE NOT att.attisdropped AND att.attnum > 0 AND tbl.relkind IN ('r', 'm')
        AND ns.nspname NOT IN ${SYSTEM_SCHEMAS}
      GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
      HAVING NOT (bool_or(att.atttypid = 'pg_catalog.name'::regtype) OR count(att.attnum) <> count(s.attname))
    ) s
  ) s2
) s3
WHERE tblpages > 8
ORDER BY bloat_size DESC
LIMIT 30`;

const BLOAT_MIN_BYTES = 10 * 1024 * 1024;

export function interpretTableBloat(rows: Row[]): CheckResult {
  const findings: HealthFinding[] = [];
  for (const r of rows) {
    const bloat = num(r.bloat_size);
    const pct = num(r.bloat_pct);
    if (bloat < BLOAT_MIN_BYTES || pct < 20) continue;
    const schema = str(r.schema_name);
    const table = str(r.table_name);
    findings.push({
      id: `tbloat:${schema}.${table}`,
      status: pct >= 50 && bloat >= 100 * 1024 * 1024 ? 'crit' : 'warn',
      title: `${schema}.${table} is about ${fmtPct(pct, 0)} bloat (estimate)`,
      evidence: `~${fmtBytes(bloat)} reclaimable of ${fmtBytes(num(r.real_size))}. VACUUM makes the space reusable; shrinking the file needs VACUUM FULL (exclusive lock) or pg_repack.`,
      action: {
        label: 'VACUUM (ANALYZE)',
        sql: `VACUUM (ANALYZE, VERBOSE) ${qualified(schema, table)};`,
      },
    });
  }
  return {
    status: worstStatus(findings.map((f) => f.status)),
    summary: findings.length
      ? `${findings.length} bloated (estimate)`
      : 'No significant table bloat (estimate)',
    findings,
    note: 'Estimate from planner statistics, not a physical measurement. Run ANALYZE first for better accuracy.',
    table: {
      columns: [
        { key: 'table', label: 'Table', width: 260 },
        { key: 'real', label: 'Size', align: 'right', width: 100 },
        { key: 'bloat', label: 'Est. bloat', align: 'right', width: 110 },
        { key: 'pct', label: 'Est. %', align: 'right', width: 80 },
      ],
      rows: rows.map((r) => ({
        table: `${str(r.schema_name)}.${str(r.table_name)}`,
        real: fmtBytes(num(r.real_size)),
        bloat: fmtBytes(num(r.bloat_size)),
        pct: fmtPct(num(r.bloat_pct), 0),
      })),
    },
  };
}

// ─── Index bloat (btree, statistical estimate) ───────────────────────

export const INDEX_BLOAT_SQL = `
WITH idx AS (
  SELECT i.indexrelid, i.indrelid, n.nspname AS schema_name, t.relname AS table_name, c.relname AS index_name,
         c.relpages, c.reltuples,
         coalesce(substring(array_to_string(c.reloptions, ' ') FROM 'fillfactor=([0-9]+)')::int, 90) AS fillfactor,
         string_to_array(i.indkey::text, ' ')::int2[] AS keys
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  JOIN pg_class t ON t.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_am am ON am.oid = c.relam
  WHERE am.amname = 'btree' AND i.indisvalid AND i.indexprs IS NULL AND c.relpages > 8
    AND n.nspname NOT IN ${SYSTEM_SCHEMAS}
), w AS (
  SELECT idx.indexrelid,
         sum((1 - coalesce(s.null_frac, 0)) * coalesce(s.avg_width, 0)) AS data_width,
         count(*) AS ncols, count(s.attname) AS nstats
  FROM idx
  CROSS JOIN LATERAL unnest(idx.keys) AS k(attnum)
  JOIN pg_attribute a ON a.attrelid = idx.indrelid AND a.attnum = k.attnum
  LEFT JOIN pg_stats s ON s.schemaname = idx.schema_name AND s.tablename = idx.table_name
                      AND s.attname = a.attname AND s.inherited = false
  GROUP BY idx.indexrelid
)
SELECT schema_name, table_name, index_name, real_size, bloat_size,
       CASE WHEN real_size > 0 THEN 100 * bloat_size / real_size::float ELSE 0 END AS bloat_pct
FROM (
  SELECT idx.schema_name, idx.table_name, idx.index_name,
         bs * idx.relpages AS real_size,
         bs * greatest(idx.relpages - (1 + ceil(idx.reltuples * (ceil((8 + w.data_width) / 8) * 8 + 4)
                                          / ((bs - 24 - 16) * idx.fillfactor / 100.0))), 0) AS bloat_size
  FROM idx
  JOIN w ON w.indexrelid = idx.indexrelid AND w.ncols = w.nstats
  CROSS JOIN (SELECT current_setting('block_size')::numeric AS bs) b
) q
ORDER BY bloat_size DESC
LIMIT 30`;

export function interpretIndexBloat(rows: Row[]): CheckResult {
  const findings: HealthFinding[] = [];
  for (const r of rows) {
    const bloat = num(r.bloat_size);
    const pct = num(r.bloat_pct);
    if (bloat < BLOAT_MIN_BYTES || pct < 30) continue;
    const schema = str(r.schema_name);
    const name = str(r.index_name);
    findings.push({
      id: `ibloat:${schema}.${name}`,
      status: pct >= 60 && bloat >= 100 * 1024 * 1024 ? 'crit' : 'warn',
      title: `${schema}.${name} is about ${fmtPct(pct, 0)} bloat (estimate)`,
      evidence: `~${fmtBytes(bloat)} reclaimable of ${fmtBytes(num(r.real_size))} on ${str(r.table_name)}.`,
      action: {
        label: 'REINDEX CONCURRENTLY',
        sql: `REINDEX INDEX CONCURRENTLY ${qualified(schema, name)};`,
      },
    });
  }
  return {
    status: worstStatus(findings.map((f) => f.status)),
    summary: findings.length
      ? `${findings.length} bloated (estimate)`
      : 'No significant index bloat (estimate)',
    findings,
    note: 'B-tree estimate from planner statistics; expression indexes are skipped.',
    table: {
      columns: [
        { key: 'index', label: 'Index', width: 280 },
        { key: 'real', label: 'Size', align: 'right', width: 100 },
        { key: 'bloat', label: 'Est. bloat', align: 'right', width: 110 },
        { key: 'pct', label: 'Est. %', align: 'right', width: 80 },
      ],
      rows: rows.map((r) => ({
        index: `${str(r.schema_name)}.${str(r.index_name)}`,
        real: fmtBytes(num(r.real_size)),
        bloat: fmtBytes(num(r.bloat_size)),
        pct: fmtPct(num(r.bloat_pct), 0),
      })),
    },
  };
}

// ─── Vacuum / analyze age and dead tuples ────────────────────────────

export const VACUUM_SQL = `
SELECT s.schemaname AS schema_name, s.relname AS table_name, s.n_live_tup, s.n_dead_tup,
       s.n_mod_since_analyze,
       extract(epoch FROM (now() - greatest(s.last_vacuum, s.last_autovacuum))) AS vacuum_age_s,
       extract(epoch FROM (now() - greatest(s.last_analyze, s.last_autoanalyze))) AS analyze_age_s,
       coalesce(c.reloptions @> ARRAY['autovacuum_enabled=false'], false) AS autovacuum_off,
       pg_relation_size(s.relid) AS size_bytes
FROM pg_stat_user_tables s
JOIN pg_class c ON c.oid = s.relid
ORDER BY s.n_dead_tup DESC
LIMIT 50`;

export interface VacuumThresholds {
  /** Dead tuples below this never raise a finding. */
  minDead: number;
  warnPct: number;
  critPct: number;
  /** Never vacuumed and more than this many modifications. */
  staleAnalyzeSeconds: number;
}

export const DEFAULT_VACUUM_THRESHOLDS: VacuumThresholds = {
  minDead: 1000,
  warnPct: 10,
  critPct: 30,
  staleAnalyzeSeconds: 7 * 24 * 3600,
};

export function interpretVacuum(
  rows: Row[],
  t: VacuumThresholds = DEFAULT_VACUUM_THRESHOLDS,
): CheckResult {
  const findings: HealthFinding[] = [];
  for (const r of rows) {
    const live = num(r.n_live_tup);
    const dead = num(r.n_dead_tup);
    const schema = str(r.schema_name);
    const table = str(r.table_name);
    const total = live + dead;
    const pct = total > 0 ? (dead / total) * 100 : 0;
    const off = bool(r.autovacuum_off);
    const q = qualified(schema, table);
    if (dead >= t.minDead && pct >= t.warnPct) {
      const vacAge = numOrNull(r.vacuum_age_s);
      findings.push({
        id: `dead:${schema}.${table}`,
        status: pct >= t.critPct ? 'crit' : 'warn',
        title: `${schema}.${table} has ${fmtInt(dead)} dead tuples (${fmtPct(pct, 0)})`,
        evidence: `${fmtInt(live)} live, ${fmtInt(dead)} dead; last vacuum ${
          vacAge === null ? 'never recorded' : `${fmtDurationMs(vacAge * 1000)} ago`
        }${off ? '; autovacuum is disabled on this table' : ''}.`,
        action: { label: 'VACUUM (ANALYZE)', sql: `VACUUM (ANALYZE, VERBOSE) ${q};` },
      });
    } else if (off && (dead > 0 || num(r.n_mod_since_analyze) > 0)) {
      findings.push({
        id: `avoff:${schema}.${table}`,
        status: 'warn',
        title: `Autovacuum is disabled on ${schema}.${table}`,
        evidence: `${fmtInt(dead)} dead tuples, ${fmtInt(num(r.n_mod_since_analyze))} rows changed since the last ANALYZE.`,
        action: {
          label: 'Re-enable autovacuum',
          sql: `ALTER TABLE ${q} RESET (autovacuum_enabled);`,
        },
      });
    }
    const analyzeAge = numOrNull(r.analyze_age_s);
    if (
      live >= 1000 &&
      num(r.n_mod_since_analyze) >= Math.max(1000, live * 0.2) &&
      (analyzeAge === null || analyzeAge > t.staleAnalyzeSeconds)
    ) {
      findings.push({
        id: `analyze:${schema}.${table}`,
        status: 'warn',
        title: `${schema}.${table} statistics are stale`,
        evidence: `${fmtInt(num(r.n_mod_since_analyze))} rows changed since the last ANALYZE (${
          analyzeAge === null ? 'never analyzed' : `${fmtDurationMs(analyzeAge * 1000)} ago`
        }); the planner may choose bad plans.`,
        action: { label: 'ANALYZE', sql: `ANALYZE ${q};` },
      });
    }
  }
  return {
    status: worstStatus(findings.map((f) => f.status)),
    summary: findings.length
      ? `${findings.length} table(s) need attention`
      : 'Vacuum and analyze are current',
    findings,
    table: {
      columns: [
        { key: 'table', label: 'Table', width: 240 },
        { key: 'live', label: 'Live', align: 'right', width: 90 },
        { key: 'dead', label: 'Dead', align: 'right', width: 90 },
        { key: 'vacuum', label: 'Last vacuum', align: 'right', width: 110 },
        { key: 'analyze', label: 'Last analyze', align: 'right', width: 110 },
      ],
      rows: rows.map((r) => {
        const v = numOrNull(r.vacuum_age_s);
        const a = numOrNull(r.analyze_age_s);
        return {
          table: `${str(r.schema_name)}.${str(r.table_name)}`,
          live: fmtInt(num(r.n_live_tup)),
          dead: fmtInt(num(r.n_dead_tup)),
          vacuum: v === null ? 'never' : `${fmtDurationMs(v * 1000)} ago`,
          analyze: a === null ? 'never' : `${fmtDurationMs(a * 1000)} ago`,
        };
      }),
    },
  };
}

// ─── Transaction-ID wraparound ───────────────────────────────────────

/** Postgres wraps xid at 2^31; autovacuum forces freezing at autovacuum_freeze_max_age. */
export const XID_LIMIT = 2_147_483_648;

export const WRAPAROUND_SQL = `
SELECT datname, age(datfrozenxid) AS xid_age, mxid_age(datminmxid) AS mxid_age,
       current_setting('autovacuum_freeze_max_age')::bigint AS freeze_max_age
FROM pg_database
WHERE datallowconn
ORDER BY age(datfrozenxid) DESC
LIMIT 20`;

export function interpretWraparound(rows: Row[]): CheckResult {
  const findings: HealthFinding[] = [];
  let worst = 0;
  for (const r of rows) {
    const age = num(r.xid_age);
    worst = Math.max(worst, age);
    const used = (age / XID_LIMIT) * 100;
    const distance = XID_LIMIT - age;
    const freeze = num(r.freeze_max_age, 200_000_000);
    if (used < 40 && age < freeze * 1.5) continue;
    findings.push({
      id: `xid:${str(r.datname)}`,
      status: used >= 75 ? 'crit' : 'warn',
      title: `${str(r.datname)} is ${fmtPct(used, 0)} of the way to transaction-ID wraparound`,
      evidence: `datfrozenxid age ${fmtInt(age)}; ${fmtInt(distance)} transactions left before Postgres stops accepting writes. Autovacuum normally freezes at ${fmtInt(freeze)}, so something is blocking it (old transactions, replication slots, prepared transactions).`,
      action: {
        label: 'VACUUM (FREEZE)',
        note: 'Find the oldest xmin holders (long transactions, inactive slots, prepared transactions), clear them, then VACUUM (FREEZE) the oldest tables.',
      },
    });
  }
  const worstRow = rows[0];
  return {
    status: worstStatus(findings.map((f) => f.status)),
    summary: worstRow ? `${fmtInt(XID_LIMIT - worst)} xids to wraparound` : 'No databases',
    findings,
    table: {
      columns: [
        { key: 'db', label: 'Database', width: 200 },
        { key: 'age', label: 'xid age', align: 'right', width: 120 },
        { key: 'left', label: 'Distance to wraparound', align: 'right', width: 180 },
        { key: 'mxid', label: 'mxid age', align: 'right', width: 120 },
      ],
      rows: rows.map((r) => ({
        db: str(r.datname),
        age: fmtInt(num(r.xid_age)),
        left: fmtInt(XID_LIMIT - num(r.xid_age)),
        mxid: fmtInt(num(r.mxid_age)),
      })),
    },
  };
}

// ─── Autovacuum status ───────────────────────────────────────────────

export const AUTOVACUUM_SQL = `
SELECT current_setting('autovacuum') AS enabled,
       current_setting('autovacuum_max_workers')::int AS max_workers,
       current_setting('track_counts') AS track_counts,
       (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'autovacuum worker')::int AS running,
       current_setting('autovacuum_naptime') AS naptime`;

export function interpretAutovacuum(rows: Row[]): CheckResult {
  const r = rows[0];
  if (!r) return { status: 'unknown', summary: 'No data', findings: [] };
  const findings: HealthFinding[] = [];
  const on = str(r.enabled) === 'on';
  const counts = str(r.track_counts) === 'on';
  const running = num(r.running);
  const max = num(r.max_workers);
  if (!on) {
    findings.push({
      id: 'autovacuum-off',
      status: 'crit',
      title: 'Autovacuum is off',
      evidence:
        'autovacuum = off: dead tuples and old transaction IDs accumulate until a manual VACUUM.',
      action: {
        label: 'Enable autovacuum',
        sql: 'ALTER SYSTEM SET autovacuum = on;\nSELECT pg_reload_conf();',
      },
    });
  } else if (!counts) {
    findings.push({
      id: 'track-counts-off',
      status: 'crit',
      title: 'track_counts is off, autovacuum cannot work',
      evidence: 'Autovacuum relies on the statistics collector to know which tables changed.',
      action: {
        label: 'Enable track_counts',
        sql: 'ALTER SYSTEM SET track_counts = on;\nSELECT pg_reload_conf();',
      },
    });
  } else if (max > 0 && running >= max) {
    findings.push({
      id: 'autovacuum-saturated',
      status: 'warn',
      title: 'All autovacuum workers are busy',
      evidence: `${running} of ${max} workers running; tables may wait for a free worker. Consider raising autovacuum_max_workers or the cost limit.`,
    });
  }
  return {
    status: worstStatus(findings.map((f) => f.status)),
    summary: !on ? 'Autovacuum is off' : `On, ${running}/${max} workers busy`,
    findings,
  };
}

export const PG_MAINTENANCE_CHECKS: PgCheck[] = [
  {
    id: 'maint-vacuum',
    section: 'maintenance',
    title: 'Vacuum, analyze and dead tuples',
    sql: VACUUM_SQL,
    interpret: (rows) => interpretVacuum(rows),
  },
  {
    id: 'maint-wraparound',
    section: 'maintenance',
    title: 'Transaction-ID wraparound',
    sql: WRAPAROUND_SQL,
    interpret: interpretWraparound,
  },
  {
    id: 'maint-autovacuum',
    section: 'maintenance',
    title: 'Autovacuum',
    sql: AUTOVACUUM_SQL,
    interpret: interpretAutovacuum,
  },
  {
    id: 'maint-table-bloat',
    section: 'maintenance',
    title: 'Table bloat (estimate)',
    sql: TABLE_BLOAT_SQL,
    timeoutMs: 20_000,
    interpret: interpretTableBloat,
  },
  {
    id: 'maint-index-bloat',
    section: 'maintenance',
    title: 'Index bloat (estimate)',
    sql: INDEX_BLOAT_SQL,
    timeoutMs: 20_000,
    interpret: interpretIndexBloat,
  },
];
