import {
  type CheckResult,
  type HealthFinding,
  type Row,
  fmtDurationMs,
  fmtInt,
  fmtPct,
  num,
  str,
  worstStatus,
} from './types';

export interface StatementRow {
  queryId: string;
  query: string;
  calls: number;
  totalMs: number;
  meanMs: number;
  rows: number;
  /** Shared-buffer hit percentage; null when the query touched no shared blocks. */
  hitPct: number | null;
}

function topSql(total: string, mean: string): string {
  return `
SELECT queryid::text AS queryid, query, calls, ${total} AS total_ms, ${mean} AS mean_ms, rows,
       shared_blks_hit, shared_blks_read
FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
ORDER BY ${total} DESC
LIMIT 50`;
}

/** PG 13+ column names. */
export const STATEMENTS_SQL = topSql('total_exec_time', 'mean_exec_time');
/** PG 12 and older. */
export const STATEMENTS_SQL_LEGACY = topSql('total_time', 'mean_time');

export const STATEMENTS_ENABLE_STEPS = [
  {
    title: '1. Preload the library',
    body: "Add pg_stat_statements to shared_preload_libraries (for example shared_preload_libraries = 'pg_stat_statements' in postgresql.conf, or ALTER SYSTEM) and restart Postgres. Managed services expose this as a parameter-group setting.",
  },
  {
    title: '2. Create the extension in this database',
    body: 'Run the statement below (it needs a role allowed to create extensions).',
    sql: 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements;',
  },
  {
    title: '3. Grant read access',
    body: 'Other roles see their own statements only unless they are members of pg_read_all_stats (or pg_monitor).',
  },
];

export function parseStatements(rows: Row[]): StatementRow[] {
  return rows.map((r) => {
    const hit = num(r.shared_blks_hit);
    const read = num(r.shared_blks_read);
    return {
      queryId: str(r.queryid),
      query: str(r.query),
      calls: num(r.calls),
      totalMs: num(r.total_ms),
      meanMs: num(r.mean_ms),
      rows: num(r.rows),
      hitPct: hit + read > 0 ? (hit / (hit + read)) * 100 : null,
    };
  });
}

/** True for query text that contains `$n` placeholders (normalised statements). */
export function hasPlaceholders(query: string): boolean {
  return /\$\d+/.test(query);
}

/**
 * SQL to paste into the editor to explain a pg_stat_statements query.
 * Normalised statements carry $1... placeholders, which only PG 16+ can
 * plan generically.
 */
export function explainSql(query: string): string {
  const q = query.trim().replace(/;+\s*$/, '');
  if (hasPlaceholders(q)) {
    return `-- Normalised by pg_stat_statements; GENERIC_PLAN needs PostgreSQL 16+.\nEXPLAIN (GENERIC_PLAN) ${q};`;
  }
  return `EXPLAIN ${q};`;
}

export function interpretStatements(rows: Row[]): CheckResult {
  const list = parseStatements(rows);
  const totalAll = list.reduce((a, s) => a + s.totalMs, 0);
  const findings: HealthFinding[] = [];
  for (const s of list.slice(0, 10)) {
    const share = totalAll > 0 ? (s.totalMs / totalAll) * 100 : 0;
    const oneLine = s.query.replace(/\s+/g, ' ').slice(0, 120);
    if (list.length > 1 && share >= 40 && s.totalMs > 1000) {
      findings.push({
        id: `stmt-share:${s.queryId}`,
        status: 'warn',
        title: `One statement takes ${fmtPct(share, 0)} of tracked time`,
        evidence: `${oneLine} (${fmtInt(s.calls)} calls, ${fmtDurationMs(s.totalMs)} total, ${fmtDurationMs(s.meanMs)} mean)`,
      });
    }
    if (s.meanMs >= 1000 && s.calls >= 5) {
      findings.push({
        id: `stmt-slow:${s.queryId}`,
        status: s.meanMs >= 10_000 ? 'crit' : 'warn',
        title: `Slow on average: ${fmtDurationMs(s.meanMs)} per call`,
        evidence: `${oneLine} (${fmtInt(s.calls)} calls)`,
      });
    }
    if (s.hitPct !== null && s.hitPct < 90 && s.calls >= 5 && s.totalMs > 1000) {
      findings.push({
        id: `stmt-cache:${s.queryId}`,
        status: 'warn',
        title: `Low cache hit (${fmtPct(s.hitPct, 0)}) for a frequent query`,
        evidence: `${oneLine} (${fmtInt(s.calls)} calls)`,
      });
    }
  }
  return {
    status: worstStatus(findings.map((f) => f.status)),
    summary: list.length
      ? `${list.length} tracked, top ${fmtDurationMs(list[0]?.totalMs ?? 0)}`
      : 'No statements tracked',
    findings,
  };
}

/** Run the top-queries query, falling back to the pre-13 column names. */
export async function loadStatements(query: (sql: string) => Promise<Row[]>): Promise<Row[]> {
  try {
    return await query(STATEMENTS_SQL);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/total_exec_time|mean_exec_time/.test(msg) && /does not exist/.test(msg)) {
      return query(STATEMENTS_SQL_LEGACY);
    }
    throw err;
  }
}
