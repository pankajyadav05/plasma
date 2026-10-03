import {
  type QualifiedName,
  type Token,
  isPunct,
  isWord,
  parseQualifiedName,
  splitTopLevelCommas,
  tokenizeSql,
} from './pg-sql-tokens';
/**
 * Lock preview for Postgres DDL: which table lock each statement takes (a
 * static table that follows the "Explicit Locking" chapter of the Postgres
 * docs), what that lock blocks, and the SQL + formatting for the live
 * context shown next to it (row estimate, size, sessions currently using
 * the table). Pure — the renderer runs `LOCK_CONTEXT_SQL` on the aux
 * connection.
 */
import { splitSqlStatementRanges } from './sql-split';

export const LOCK_MODES = [
  'ACCESS SHARE',
  'ROW SHARE',
  'ROW EXCLUSIVE',
  'SHARE UPDATE EXCLUSIVE',
  'SHARE',
  'SHARE ROW EXCLUSIVE',
  'EXCLUSIVE',
  'ACCESS EXCLUSIVE',
] as const;
export type LockMode = (typeof LOCK_MODES)[number];

export type LockBlocks = 'nothing' | 'writes' | 'reads and writes';

export function lockRank(mode: LockMode): number {
  return LOCK_MODES.indexOf(mode);
}

/** What a table-level lock stops ordinary sessions from doing. */
export function lockBlocks(mode: LockMode): LockBlocks {
  switch (mode) {
    case 'ACCESS EXCLUSIVE':
      return 'reads and writes';
    case 'EXCLUSIVE':
    case 'SHARE ROW EXCLUSIVE':
    case 'SHARE':
      return 'writes';
    default:
      return 'nothing';
  }
}

/** One-line explanation including the DDL-only conflicts. */
export function lockBlocksDetail(mode: LockMode): string {
  switch (mode) {
    case 'ACCESS EXCLUSIVE':
      return 'Blocks reads and writes (SELECT, INSERT, UPDATE, DELETE) until it commits; queries arriving later queue behind it.';
    case 'EXCLUSIVE':
      return 'Blocks writes and row locks; plain SELECTs still run.';
    case 'SHARE ROW EXCLUSIVE':
      return 'Blocks writes (and other DDL); plain SELECTs still run.';
    case 'SHARE':
      return 'Blocks writes (INSERT, UPDATE, DELETE) for its duration; SELECTs still run.';
    case 'SHARE UPDATE EXCLUSIVE':
      return 'Blocks nothing but other DDL, VACUUM and ANALYZE on the table.';
    case 'ROW EXCLUSIVE':
      return 'Blocks nothing user-visible (conflicts only with SHARE and stronger).';
    case 'ROW SHARE':
      return 'Blocks nothing user-visible.';
    default:
      return 'Blocks nothing (only conflicts with ACCESS EXCLUSIVE).';
  }
}

export interface LockTarget {
  /** Source form, suitable for `to_regclass`. */
  raw: string;
  display: string;
  kind: 'table' | 'index';
  mode: LockMode;
  /** Locked as the referenced side of a foreign key. */
  referenced?: boolean;
}

export interface StatementLock {
  statementIndex: number;
  start: number;
  end: number;
  /** First keyword, upper-cased: ALTER, CREATE, DROP… */
  verb: string;
  /** Strongest lock the statement takes. */
  mode: LockMode;
  blocks: LockBlocks;
  targets: LockTarget[];
  /** The statement can be slow on big tables (scan / rewrite / build). */
  note?: string;
}

function max(a: LockMode, b: LockMode): LockMode {
  return lockRank(a) >= lockRank(b) ? a : b;
}

function tableNames(toks: Token[], from: number): QualifiedName[] {
  const out: QualifiedName[] = [];
  for (const group of splitTopLevelCommas(toks.slice(from))) {
    let i = 0;
    if (isWord(group[i], 'only')) i++;
    const n = parseQualifiedName(group, i);
    if (n) out.push(n.name);
  }
  return out;
}

function target(
  n: QualifiedName,
  mode: LockMode,
  kind: 'table' | 'index' = 'table',
  referenced = false,
): LockTarget {
  return { raw: n.raw, display: n.display, kind, mode, ...(referenced ? { referenced } : {}) };
}

function referencedTables(toks: Token[]): LockTarget[] {
  const out: LockTarget[] = [];
  for (let i = 0; i < toks.length; i++) {
    if (isWord(toks[i], 'references')) {
      const n = parseQualifiedName(toks, i + 1);
      if (n) out.push(target(n.name, 'SHARE ROW EXCLUSIVE', 'table', true));
    }
  }
  return out;
}

function alterTableMode(action: Token[]): LockMode {
  const verb = action[0];
  const has = (...w: string[]) =>
    action.some((t, i) => w.every((x, k) => isWord(action[i + k], x)) && t.kind === 'word');
  if (isWord(verb, 'add') && has('foreign', 'key')) return 'SHARE ROW EXCLUSIVE';
  if (isWord(verb, 'validate')) return 'SHARE UPDATE EXCLUSIVE';
  if (isWord(verb, 'attach') || isWord(verb, 'detach')) return 'SHARE UPDATE EXCLUSIVE';
  if (isWord(verb, 'set') && isPunct(action[1], '(')) return 'SHARE UPDATE EXCLUSIVE';
  if (isWord(verb, 'reset') && isPunct(action[1], '(')) return 'SHARE UPDATE EXCLUSIVE';
  if (isWord(verb, 'cluster') || (isWord(verb, 'set') && isWord(action[1], 'without')))
    return 'SHARE UPDATE EXCLUSIVE';
  if (isWord(verb, 'alter') && has('set', 'statistics')) return 'SHARE UPDATE EXCLUSIVE';
  if (isWord(verb, 'enable', 'disable') && has('trigger')) return 'SHARE ROW EXCLUSIVE';
  return 'ACCESS EXCLUSIVE';
}

function slowNote(toks: Token[]): string | undefined {
  const has = (...w: string[]) => toks.some((_, i) => w.every((x, k) => isWord(toks[i + k], x)));
  if (has('set', 'not', 'null')) return 'Scans every row to verify the column has no NULLs.';
  if (has('type') && has('alter')) return 'May rewrite the whole table and its indexes.';
  if (has('add', 'foreign', 'key') && !has('not', 'valid'))
    return 'Scans the table to validate the foreign key.';
  if (has('add') && has('check') && !has('not', 'valid'))
    return 'Scans the table to validate the constraint.';
  return undefined;
}

function analyze(idx: number, text: string, offset: number): StatementLock | null {
  const toks = tokenizeSql(text, offset);
  const first = toks[0];
  if (!first || first.kind !== 'word') return null;
  const verb = first.value.toUpperCase();
  const base = { statementIndex: idx, start: first.start, end: toks[toks.length - 1]!.end, verb };
  const done = (targets: LockTarget[], note?: string): StatementLock | null => {
    if (targets.length === 0) return null;
    const mode = targets.reduce<LockMode>((m, t) => max(m, t.mode), 'ACCESS SHARE');
    return { ...base, mode, blocks: lockBlocks(mode), targets, ...(note ? { note } : {}) };
  };

  switch (first.value) {
    case 'alter': {
      if (!isWord(toks[1], 'table')) return null;
      let i = 2;
      if (isWord(toks[i], 'if') && isWord(toks[i + 1], 'exists')) i += 2;
      if (isWord(toks[i], 'only')) i++;
      const n = parseQualifiedName(toks, i);
      if (!n) return null;
      i = n.next;
      if (isPunct(toks[i], '*')) i++;
      const actions = splitTopLevelCommas(toks.slice(i));
      let mode: LockMode = 'ACCESS EXCLUSIVE';
      if (actions.length > 0) {
        mode = actions.map(alterTableMode).reduce<LockMode>((m, x) => max(m, x), 'ACCESS SHARE');
      }
      return done(
        [target(n.name, mode), ...referencedTables(toks.slice(i))],
        slowNote(toks.slice(i)),
      );
    }
    case 'create': {
      let i = 1;
      if (isWord(toks[i], 'or') && isWord(toks[i + 1], 'replace')) i += 2;
      const unique = isWord(toks[i], 'unique');
      if (unique) i++;
      if (isWord(toks[i], 'index')) {
        i++;
        const conc = isWord(toks[i], 'concurrently');
        if (conc) i++;
        if (isWord(toks[i], 'if') && isWord(toks[i + 1], 'not')) i += 3;
        const on = toks.findIndex((t, k) => k >= i && isWord(t, 'on'));
        if (on < 0) return null;
        let j = on + 1;
        if (isWord(toks[j], 'only')) j++;
        const n = parseQualifiedName(toks, j);
        if (!n) return null;
        return done(
          [target(n.name, conc ? 'SHARE UPDATE EXCLUSIVE' : 'SHARE')],
          conc
            ? 'Builds in two passes and waits for older transactions; writes keep flowing.'
            : 'Reads the whole table to build the index.',
        );
      }
      if (isWord(toks[i], 'constraint') || isWord(toks[i], 'trigger')) {
        const on = toks.findIndex((t, k) => k >= i && isWord(t, 'on'));
        const n = on >= 0 ? parseQualifiedName(toks, on + 1) : null;
        return n ? done([target(n.name, 'SHARE ROW EXCLUSIVE')]) : null;
      }
      if (
        isWord(toks[i], 'table') ||
        (isWord(toks[i + 1], 'table') && !unique) ||
        isWord(toks[i + 2], 'table')
      ) {
        return done(referencedTables(toks));
      }
      return null;
    }
    case 'drop': {
      if (isWord(toks[1], 'index')) {
        let i = 2;
        const conc = isWord(toks[i], 'concurrently');
        if (conc) i++;
        if (isWord(toks[i], 'if') && isWord(toks[i + 1], 'exists')) i += 2;
        const names = tableNames(toks, i);
        return done(
          names.map((n) =>
            target(n, conc ? 'SHARE UPDATE EXCLUSIVE' : 'ACCESS EXCLUSIVE', 'index'),
          ),
        );
      }
      if (isWord(toks[1], 'table')) {
        let i = 2;
        if (isWord(toks[i], 'if') && isWord(toks[i + 1], 'exists')) i += 2;
        return done(tableNames(toks, i).map((n) => target(n, 'ACCESS EXCLUSIVE')));
      }
      return null;
    }
    case 'truncate': {
      let i = 1;
      if (isWord(toks[i], 'table')) i++;
      const end = toks.findIndex(
        (t, k) => k >= i && isWord(t, 'restart', 'continue', 'cascade', 'restrict'),
      );
      return done(
        tableNames(end < 0 ? toks : toks.slice(0, end), i).map((n) =>
          target(n, 'ACCESS EXCLUSIVE'),
        ),
      );
    }
    case 'vacuum': {
      const full =
        isWord(toks[1], 'full') ||
        (isPunct(toks[1], '(') && toks.slice(2).some((t) => isWord(t, 'full')));
      let i = 1;
      if (isPunct(toks[i], '(')) {
        while (i < toks.length && !isPunct(toks[i], ')')) i++;
        i++;
      } else {
        while (isWord(toks[i], 'full', 'freeze', 'verbose', 'analyze', 'analyse')) i++;
      }
      const names = tableNames(toks, i).map((n) =>
        target(n, full ? 'ACCESS EXCLUSIVE' : 'SHARE UPDATE EXCLUSIVE'),
      );
      return done(names, full ? 'Rewrites the table into a new file.' : undefined);
    }
    case 'analyze':
    case 'analyse': {
      let i = 1;
      if (isWord(toks[i], 'verbose')) i++;
      return done(tableNames(toks, i).map((n) => target(n, 'SHARE UPDATE EXCLUSIVE')));
    }
    case 'cluster': {
      let i = 1;
      if (isWord(toks[i], 'verbose')) i++;
      const n = parseQualifiedName(toks, i);
      return n
        ? done([target(n.name, 'ACCESS EXCLUSIVE')], 'Rewrites the table in index order.')
        : null;
    }
    case 'reindex': {
      let i = 1;
      if (isPunct(toks[i], '(')) {
        while (i < toks.length && !isPunct(toks[i], ')')) i++;
        i++;
      }
      const kind = toks[i]?.value;
      if (kind !== 'table' && kind !== 'index') return null;
      i++;
      const conc = isWord(toks[i], 'concurrently');
      if (conc) i++;
      const n = parseQualifiedName(toks, i);
      if (!n) return null;
      const mode: LockMode = conc
        ? 'SHARE UPDATE EXCLUSIVE'
        : kind === 'table'
          ? 'SHARE'
          : 'ACCESS EXCLUSIVE';
      return done([target(n.name, mode, kind === 'index' ? 'index' : 'table')]);
    }
    case 'lock': {
      let i = 1;
      if (isWord(toks[i], 'table')) i++;
      const inAt = toks.findIndex((t, k) => k >= i && isWord(t, 'in'));
      const names = tableNames(inAt < 0 ? toks : toks.slice(0, inAt), i);
      let mode: LockMode = 'ACCESS EXCLUSIVE';
      if (inAt >= 0) {
        const modeText = toks
          .slice(inAt + 1)
          .map((t) => t.value.toUpperCase())
          .join(' ');
        const found = [...LOCK_MODES]
          .sort((a, b) => b.length - a.length)
          .find((m) => modeText.startsWith(`${m} MODE`));
        if (found) mode = found;
      }
      return done(names.map((n) => target(n, mode)));
    }
    case 'refresh': {
      let i = 2;
      if (!isWord(toks[1], 'materialized')) return null;
      i = 3;
      const conc = isWord(toks[i], 'concurrently');
      if (conc) i++;
      const n = parseQualifiedName(toks, i);
      return n
        ? done(
            [target(n.name, conc ? 'EXCLUSIVE' : 'ACCESS EXCLUSIVE')],
            'Recomputes the whole view.',
          )
        : null;
    }
    case 'insert': {
      if (!isWord(toks[1], 'into')) return null;
      const n = parseQualifiedName(toks, 2);
      return n ? done([target(n.name, 'ROW EXCLUSIVE')]) : null;
    }
    case 'update': {
      let i = 1;
      if (isWord(toks[i], 'only')) i++;
      const n = parseQualifiedName(toks, i);
      return n ? done([target(n.name, 'ROW EXCLUSIVE')]) : null;
    }
    case 'delete': {
      if (!isWord(toks[1], 'from')) return null;
      let i = 2;
      if (isWord(toks[i], 'only')) i++;
      const n = parseQualifiedName(toks, i);
      return n ? done([target(n.name, 'ROW EXCLUSIVE')]) : null;
    }
    default:
      return null;
  }
}

/** Table locks taken by each statement of a script (statements without a table lock are omitted). */
export function analyzeLocks(sql: string): StatementLock[] {
  const out: StatementLock[] = [];
  splitSqlStatementRanges(sql).forEach((s, idx) => {
    try {
      const l = analyze(idx, s.text, s.start);
      if (l) out.push(l);
    } catch {
      // never block the preview on a parser bug
    }
  });
  return out;
}

/** Distinct relation names (source form) a script locks — input for the live context. */
export function lockTargetNames(locks: readonly StatementLock[]): string[] {
  const seen = new Set<string>();
  for (const l of locks) for (const t of l.targets) seen.add(t.raw);
  return [...seen];
}

// ─── Live context ────────────────────────────────────────────────────

export interface LockSession {
  pid: number;
  user: string | null;
  state: string | null;
  modes: string;
  waiting: boolean;
  query: string | null;
  durationMs: number | null;
}

export interface LockContext {
  /** Name as requested (matches `LockTarget.raw`). */
  name: string;
  /** Resolved `schema.table`, or null when the relation does not exist. */
  resolved: string | null;
  relkind: string | null;
  estRows: number | null;
  totalBytes: number | null;
  /** Distinct other sessions holding or waiting on any lock of the table. */
  sessionCount: number;
  holders: number;
  waiters: number;
  sessions: LockSession[];
  columns: { name: string; type: string }[];
  /** Column lists of the table's valid indexes. */
  indexes: string[][];
}

/**
 * Live context for relations: `$1` is a text[] of names as written in the
 * SQL (resolved with `to_regclass`, so quoting/search_path behave like the
 * statement itself). An index name resolves to its table. Read-only.
 */
export const LOCK_CONTEXT_SQL = `
WITH req AS (
  SELECT n AS name, to_regclass(n) AS oid FROM unnest($1::text[]) AS n
), rel AS (
  SELECT req.name,
         CASE WHEN c.relkind IN ('i', 'I') THEN i.indrelid ELSE c.oid END AS oid
  FROM req
  LEFT JOIN pg_class c ON c.oid = req.oid
  LEFT JOIN pg_index i ON i.indexrelid = c.oid
)
SELECT rel.name AS name,
  rel.oid::regclass::text AS resolved,
  c.relkind::text AS relkind,
  CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS est_rows,
  -- Estimated from pg_class.relpages (table + indexes + toast). pg_total_relation_size()
  -- would queue behind an ACCESS EXCLUSIVE lock, which is exactly when this runs.
  CASE WHEN c.relpages > 0 THEN
    (c.relpages::bigint
       + COALESCE((SELECT sum(ic.relpages) FROM pg_index x JOIN pg_class ic ON ic.oid = x.indexrelid
                    WHERE x.indrelid = rel.oid), 0)
       + COALESCE(t.relpages, 0)) * current_setting('block_size')::bigint
  END AS total_bytes,
  (SELECT count(DISTINCT l.pid)::int FROM pg_locks l
     WHERE l.relation = rel.oid AND l.pid <> pg_backend_pid()) AS session_count,
  (SELECT count(DISTINCT l.pid)::int FROM pg_locks l
     WHERE l.relation = rel.oid AND l.granted AND l.pid <> pg_backend_pid()) AS holders,
  (SELECT count(DISTINCT l.pid)::int FROM pg_locks l
     WHERE l.relation = rel.oid AND NOT l.granted AND l.pid <> pg_backend_pid()) AS waiters,
  (SELECT COALESCE(json_agg(s), '[]'::json) FROM (
     SELECT l.pid,
            a.usename::text AS "user",
            a.state::text AS state,
            string_agg(DISTINCT l.mode, ', ') AS modes,
            bool_or(NOT l.granted) AS waiting,
            left(a.query, 200) AS query,
            (EXTRACT(EPOCH FROM (now() - COALESCE(a.xact_start, a.query_start))) * 1000)::bigint AS duration_ms
       FROM pg_locks l
       JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.relation = rel.oid AND l.pid <> pg_backend_pid()
      GROUP BY l.pid, a.usename, a.state, a.query, a.xact_start, a.query_start
      ORDER BY bool_or(NOT l.granted) DESC, COALESCE(a.xact_start, a.query_start) NULLS LAST
      LIMIT 20) s) AS sessions,
  (SELECT COALESCE(json_agg(json_build_object('name', a.attname::text,
                                              'type', format_type(a.atttypid, a.atttypmod))
                            ORDER BY a.attnum), '[]'::json)
     FROM pg_attribute a
    WHERE a.attrelid = rel.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns,
  (SELECT COALESCE(json_agg(q.cols), '[]'::json) FROM (
     SELECT (SELECT array_agg(COALESCE(a.attname::text, '(expr)') ORDER BY k.ord)
               FROM unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
               LEFT JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum) AS cols
       FROM pg_index ix WHERE ix.indrelid = rel.oid AND ix.indisvalid) q) AS indexes
FROM rel
LEFT JOIN pg_class c ON c.oid = rel.oid
LEFT JOIN pg_class t ON t.oid = c.reltoastrelid
`;

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function jsonArr(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Rows of `LOCK_CONTEXT_SQL` (object rows) → context keyed by requested name. */
export function parseLockContext(
  rows: readonly Record<string, unknown>[],
): Map<string, LockContext> {
  const out = new Map<string, LockContext>();
  for (const r of rows) {
    const name = String(r.name ?? '');
    out.set(name, {
      name,
      resolved: typeof r.resolved === 'string' ? r.resolved : null,
      relkind: typeof r.relkind === 'string' ? r.relkind : null,
      estRows: num(r.est_rows),
      totalBytes: num(r.total_bytes),
      sessionCount: num(r.session_count) ?? 0,
      holders: num(r.holders) ?? 0,
      waiters: num(r.waiters) ?? 0,
      sessions: jsonArr(r.sessions).map((s) => {
        const o = s as Record<string, unknown>;
        return {
          pid: num(o.pid) ?? 0,
          user: typeof o.user === 'string' ? o.user : null,
          state: typeof o.state === 'string' ? o.state : null,
          modes: String(o.modes ?? ''),
          waiting: o.waiting === true,
          query: typeof o.query === 'string' ? o.query : null,
          durationMs: num(o.duration_ms),
        };
      }),
      columns: jsonArr(r.columns).map((c) => {
        const o = c as Record<string, unknown>;
        return { name: String(o.name ?? ''), type: String(o.type ?? '') };
      }),
      indexes: jsonArr(r.indexes).map((ix) => jsonArr(ix).map(String)),
    });
  }
  return out;
}

export function humanRows(n: number): string {
  if (n >= 1_000_000_000) return `${trim1(n / 1_000_000_000)}B`;
  if (n >= 1_000_000) return `${trim1(n / 1_000_000)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${trim1(n / 1000)}k`;
  return String(Math.round(n));
}

function trim1(x: number): string {
  return x.toFixed(1).replace(/\.0$/, '');
}

export function humanBytes(n: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${u === 0 ? Math.round(v) : trim1(v)} ${units[u]}`;
}

export interface LockLine {
  mode: LockMode;
  blocks: LockBlocks;
  table: string;
  /** Sessions holding or waiting on locks of this table right now (null = unknown). */
  sessionCount: number | null;
  waiters: number;
  text: string;
}

/** "This ALTER takes ACCESS EXCLUSIVE on public.orders (≈1.2M rows); 3 sessions are using it now." */
export function describeLockTarget(
  lock: StatementLock,
  t: LockTarget,
  ctx?: LockContext | null,
): LockLine {
  const live = ctx && ctx.resolved !== null ? ctx : null;
  const shown = live?.resolved ?? t.display;
  const bits: string[] = [];
  if (live) {
    if (live.estRows !== null && live.estRows > 0) bits.push(`≈${humanRows(live.estRows)} rows`);
    if (live.totalBytes !== null) bits.push(humanBytes(live.totalBytes));
  }
  const where = bits.length > 0 ? ` (${bits.join(', ')})` : '';
  const what = t.kind === 'index' ? `index ${shown} (and its table)` : shown;
  let text = `This ${lock.verb} takes ${t.mode} on ${what}${where}`;
  let sessionCount: number | null = null;
  let waiters = 0;
  if (ctx && ctx.resolved === null) {
    text += '; the relation was not found, so nothing is locked yet.';
  } else if (live) {
    sessionCount = live.sessionCount;
    waiters = live.waiters;
    if (sessionCount === 0) text += '; no other session is using it now.';
    else {
      text += `; ${sessionCount} ${sessionCount === 1 ? 'session is' : 'sessions are'} using it now`;
      text += waiters > 0 ? ` (${waiters} waiting).` : '.';
    }
  } else text += '.';
  return { mode: t.mode, blocks: lockBlocks(t.mode), table: shown, sessionCount, waiters, text };
}
