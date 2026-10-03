import {
  type CheckResult,
  type HealthFinding,
  type PgCheck,
  type Row,
  bool,
  fmtBytes,
  fmtInt,
  num,
  qualified,
  quoteIdent,
  str,
  worstStatus,
} from './types';

const SYSTEM_SCHEMAS = `('pg_catalog','information_schema','pg_toast')`;
const UNUSED_BYTES_WARN = 1024 * 1024;

// ─── Unused indexes ──────────────────────────────────────────────────

export const UNUSED_INDEXES_SQL = `
SELECT s.schemaname AS schema_name, s.relname AS table_name, s.indexrelname AS index_name,
       s.idx_scan, pg_relation_size(s.indexrelid) AS size_bytes,
       pg_get_indexdef(s.indexrelid) AS indexdef,
       (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()) AS stats_reset
FROM pg_stat_user_indexes s
JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE s.idx_scan = 0
  AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion
  AND i.indisvalid
  AND s.schemaname NOT IN ${SYSTEM_SCHEMAS}
ORDER BY pg_relation_size(s.indexrelid) DESC
LIMIT 50`;

export function dropIndexSql(schema: string, index: string): string {
  return `DROP INDEX CONCURRENTLY IF EXISTS ${qualified(schema, index)};`;
}

export function interpretUnusedIndexes(rows: Row[]): CheckResult {
  const reset = rows[0]?.stats_reset ? str(rows[0].stats_reset) : null;
  const findings: HealthFinding[] = rows.map((r) => {
    const size = num(r.size_bytes);
    return {
      id: `unused:${str(r.schema_name)}.${str(r.index_name)}`,
      status: size >= UNUSED_BYTES_WARN ? 'warn' : 'ok',
      title: `${str(r.schema_name)}.${str(r.index_name)} is never used`,
      evidence: `0 scans since stats reset on ${str(r.table_name)}; occupies ${fmtBytes(size)}. ${str(r.indexdef)}`,
      action: {
        label: 'Drop index',
        sql: dropIndexSql(str(r.schema_name), str(r.index_name)),
        destructive: true,
      },
    };
  });
  const total = rows.reduce((a, r) => a + num(r.size_bytes), 0);
  const status = worstStatus(findings.map((f) => f.status));
  return {
    status,
    summary: rows.length === 0 ? 'No unused indexes' : `${rows.length} unused, ${fmtBytes(total)}`,
    findings,
    note: reset
      ? `Counted since the statistics were last reset (${reset}). An index that serves a rare job (monthly report) can look unused.`
      : 'Counted since the statistics were last reset.',
  };
}

// ─── Duplicate / overlapping indexes ─────────────────────────────────

export const INDEX_CATALOG_SQL = `
SELECT n.nspname AS schema_name, t.relname AS table_name, c.relname AS index_name,
       am.amname AS method,
       i.indkey::text AS keys, i.indclass::text AS opclasses, i.indcollation::text AS collations,
       i.indoption::text AS options,
       coalesce(pg_get_expr(i.indpred, i.indrelid), '') AS predicate,
       coalesce(pg_get_expr(i.indexprs, i.indrelid), '') AS expressions,
       i.indisunique AS is_unique, i.indisprimary AS is_primary,
       EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid) AS backs_constraint,
       pg_relation_size(i.indexrelid) AS size_bytes,
       pg_get_indexdef(i.indexrelid) AS indexdef
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
JOIN pg_class t ON t.oid = i.indrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
JOIN pg_am am ON am.oid = c.relam
WHERE i.indisvalid AND n.nspname NOT IN ${SYSTEM_SCHEMAS}
ORDER BY n.nspname, t.relname, c.relname`;

interface Idx {
  schema: string;
  table: string;
  name: string;
  method: string;
  keys: string[];
  opclasses: string[];
  collations: string[];
  options: string[];
  predicate: string;
  expressions: string;
  unique: boolean;
  primary: boolean;
  constraint: boolean;
  size: number;
  def: string;
}

function parseIdx(r: Row): Idx {
  const split = (v: unknown) => str(v).split(/\s+/).filter(Boolean);
  return {
    schema: str(r.schema_name),
    table: str(r.table_name),
    name: str(r.index_name),
    method: str(r.method),
    keys: split(r.keys),
    opclasses: split(r.opclasses),
    collations: split(r.collations),
    options: split(r.options),
    predicate: str(r.predicate),
    expressions: str(r.expressions),
    unique: bool(r.is_unique),
    primary: bool(r.is_primary),
    constraint: bool(r.backs_constraint),
    size: num(r.size_bytes),
    def: str(r.indexdef),
  };
}

/** An index we must never suggest dropping: it enforces something. */
function protectedIdx(i: Idx): boolean {
  return i.unique || i.primary || i.constraint;
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, k) => v === b[k]);
}

/** `short` is a strict leading prefix of `long` (columns, opclass, collation, order). */
function isPrefix(short: Idx, long: Idx): boolean {
  const n = short.keys.length;
  if (n >= long.keys.length) return false;
  const head = (l: string[]) => l.slice(0, n);
  return (
    sameList(short.keys, head(long.keys)) &&
    sameList(short.opclasses, head(long.opclasses)) &&
    sameList(short.collations, head(long.collations)) &&
    sameList(short.options, head(long.options))
  );
}

export function findRedundantIndexes(rows: Row[]): HealthFinding[] {
  const all = rows.map(parseIdx);
  const byTable = new Map<string, Idx[]>();
  for (const i of all) {
    const k = `${i.schema}.${i.table}`;
    byTable.set(k, [...(byTable.get(k) ?? []), i]);
  }
  const findings: HealthFinding[] = [];
  const reported = new Set<string>();
  for (const list of byTable.values()) {
    for (const a of list) {
      for (const b of list) {
        if (a === b || a.method !== b.method || a.method !== 'btree') continue;
        if (a.predicate !== b.predicate || a.expressions !== b.expressions) continue;
        const exact =
          sameList(a.keys, b.keys) &&
          sameList(a.opclasses, b.opclasses) &&
          sameList(a.collations, b.collations) &&
          sameList(a.options, b.options);
        // Exact twins: judge each pair once, keep the more protected / first one.
        if (exact) {
          if (a.name > b.name) continue;
          const [keep, drop] = protectedIdx(b) && !protectedIdx(a) ? [b, a] : [a, b];
          if (protectedIdx(drop)) continue;
          const id = `dup:${drop.schema}.${drop.name}`;
          if (reported.has(id)) continue;
          reported.add(id);
          findings.push({
            id,
            status: 'warn',
            title: `${drop.schema}.${drop.name} duplicates ${keep.name}`,
            evidence: `Identical definition on ${drop.table}; wastes ${fmtBytes(drop.size)} and slows writes. ${drop.def}`,
            action: {
              label: 'Drop duplicate',
              sql: dropIndexSql(drop.schema, drop.name),
              destructive: true,
            },
          });
        } else if (isPrefix(a, b) && !protectedIdx(a)) {
          // `a` (the shorter) is covered by `b` for every lookup it could serve.
          const id = `overlap:${a.schema}.${a.name}`;
          if (reported.has(id)) continue;
          reported.add(id);
          findings.push({
            id,
            status: 'warn',
            title: `${a.schema}.${a.name} overlaps ${b.name}`,
            evidence: `Its columns are a leading prefix of ${b.name} on ${a.table}, so ${b.name} can serve the same lookups. Frees ${fmtBytes(a.size)}. ${a.def}`,
            action: {
              label: 'Drop overlapping index',
              sql: dropIndexSql(a.schema, a.name),
              destructive: true,
            },
          });
        }
      }
    }
  }
  return findings;
}

export function interpretDuplicateIndexes(rows: Row[]): CheckResult {
  const findings = findRedundantIndexes(rows);
  return {
    status: findings.length ? 'warn' : 'ok',
    summary: findings.length ? `${findings.length} redundant` : 'No duplicate indexes',
    findings,
  };
}

// ─── Invalid indexes ─────────────────────────────────────────────────

export const INVALID_INDEXES_SQL = `
SELECT n.nspname AS schema_name, t.relname AS table_name, c.relname AS index_name,
       pg_relation_size(i.indexrelid) AS size_bytes, pg_get_indexdef(i.indexrelid) AS indexdef
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
JOIN pg_class t ON t.oid = i.indrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE NOT i.indisvalid AND n.nspname NOT IN ${SYSTEM_SCHEMAS}
ORDER BY 1, 2, 3`;

export function interpretInvalidIndexes(rows: Row[]): CheckResult {
  const findings: HealthFinding[] = rows.map((r) => ({
    id: `invalid:${str(r.schema_name)}.${str(r.index_name)}`,
    status: 'crit',
    title: `${str(r.schema_name)}.${str(r.index_name)} is invalid`,
    evidence: `A failed CREATE INDEX CONCURRENTLY left it behind on ${str(r.table_name)}. It is ignored by queries but still slows writes (${fmtBytes(num(r.size_bytes))}). Drop it, then recreate. ${str(r.indexdef)}`,
    action: {
      label: 'Drop invalid index',
      sql: dropIndexSql(str(r.schema_name), str(r.index_name)),
      destructive: true,
    },
  }));
  return {
    status: findings.length ? 'crit' : 'ok',
    summary: findings.length ? `${findings.length} invalid` : 'No invalid indexes',
    findings,
  };
}

// ─── Missing-index hints ─────────────────────────────────────────────

export const SEQ_SCAN_SQL = `
SELECT schemaname AS schema_name, relname AS table_name, seq_scan, seq_tup_read,
       coalesce(idx_scan, 0) AS idx_scan, n_live_tup,
       pg_relation_size(relid) AS size_bytes
FROM pg_stat_user_tables
WHERE seq_scan > 0 AND n_live_tup >= 10000
ORDER BY seq_tup_read DESC
LIMIT 20`;

export function interpretSeqScans(rows: Row[]): CheckResult {
  const findings: HealthFinding[] = [];
  for (const r of rows) {
    const seq = num(r.seq_scan);
    const idx = num(r.idx_scan);
    const read = num(r.seq_tup_read);
    const live = num(r.n_live_tup);
    // Hot table: lots of rows read sequentially and sequential scans dominate.
    if (read < 1_000_000 || seq < 10 || seq <= idx) continue;
    findings.push({
      id: `seq:${str(r.schema_name)}.${str(r.table_name)}`,
      status: read >= 100_000_000 ? 'crit' : 'warn',
      title: `${str(r.schema_name)}.${str(r.table_name)} is mostly read by sequential scan`,
      evidence: `${fmtInt(seq)} seq scans vs ${fmtInt(idx)} index scans; ${fmtInt(read)} rows read sequentially from ~${fmtInt(live)} live rows (${fmtBytes(num(r.size_bytes))}). Find the filter columns in Top queries and index them.`,
      action: {
        label: 'Find the queries',
        note: `Look for WHERE / JOIN columns on ${str(r.table_name)} in the Top queries section.`,
      },
    });
  }
  return {
    status: worstStatus(findings.map((f) => f.status)),
    summary: findings.length
      ? `${findings.length} table(s) mostly seq-scanned`
      : 'No hot seq scans',
    findings,
    note: 'Heuristic from pg_stat_user_tables counters; a small hot table scanned sequentially is often fine.',
  };
}

export const FK_NO_INDEX_SQL = `
SELECT n.nspname AS schema_name, t.relname AS table_name, c.conname AS constraint_name,
       (SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY k.ord)
          FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS columns,
       pg_relation_size(c.conrelid) AS size_bytes
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE c.contype = 'f' AND n.nspname NOT IN ${SYSTEM_SCHEMAS}
  AND NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = c.conrelid AND i.indisvalid
      AND (string_to_array(i.indkey::text, ' ')::int2[])[1:cardinality(c.conkey)] @> c.conkey)
ORDER BY pg_relation_size(c.conrelid) DESC
LIMIT 50`;

export function interpretFkWithoutIndex(rows: Row[]): CheckResult {
  const findings: HealthFinding[] = rows.map((r) => {
    const size = num(r.size_bytes);
    const schema = str(r.schema_name);
    const table = str(r.table_name);
    const cols = str(r.columns);
    return {
      id: `fk:${schema}.${table}.${str(r.constraint_name)}`,
      status: size >= 10 * 1024 * 1024 ? 'warn' : 'ok',
      title: `${schema}.${table}(${cols}) has no index for foreign key ${str(r.constraint_name)}`,
      evidence: `Deleting or updating a parent row scans ${table} (${fmtBytes(size)}); joins on ${cols} cannot use an index.`,
      action: {
        label: 'Create index',
        sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${quoteIdent(`${table}_${cols.replace(/[^a-z0-9_]+/gi, '_')}_idx`.slice(0, 63))} ON ${qualified(schema, table)} (${cols});`,
      },
    };
  });
  return {
    status: worstStatus(findings.map((f) => f.status)),
    summary: findings.length ? `${findings.length} FK without index` : 'All FKs indexed',
    findings,
  };
}

export const PG_INDEX_CHECKS: PgCheck[] = [
  {
    id: 'idx-unused',
    section: 'indexes',
    title: 'Unused indexes',
    sql: UNUSED_INDEXES_SQL,
    interpret: interpretUnusedIndexes,
  },
  {
    id: 'idx-duplicate',
    section: 'indexes',
    title: 'Duplicate and overlapping indexes',
    sql: INDEX_CATALOG_SQL,
    interpret: interpretDuplicateIndexes,
  },
  {
    id: 'idx-invalid',
    section: 'indexes',
    title: 'Invalid indexes',
    sql: INVALID_INDEXES_SQL,
    interpret: interpretInvalidIndexes,
  },
  {
    id: 'idx-seqscan',
    section: 'indexes',
    title: 'Missing-index hints: sequential scans',
    sql: SEQ_SCAN_SQL,
    interpret: interpretSeqScans,
  },
  {
    id: 'idx-fk',
    section: 'indexes',
    title: 'Missing-index hints: foreign keys',
    sql: FK_NO_INDEX_SQL,
    interpret: interpretFkWithoutIndex,
  },
];
