import { type Row, bool, num, numOrNull, str } from './types';

/** Live activity with blocking pids, for the activity table and the lock-wait graph. */
export const ACTIVITY_SQL = `
SELECT
  pid,
  state,
  usename AS "user",
  datname AS database,
  application_name AS application_name,
  COALESCE(client_addr::text, '') AS client_addr,
  to_char(backend_start, 'YYYY-MM-DD HH24:MI:SS TZ') AS backend_start,
  to_char(query_start,   'YYYY-MM-DD HH24:MI:SS TZ') AS query_start,
  to_char(state_change,  'YYYY-MM-DD HH24:MI:SS TZ') AS state_change,
  wait_event_type,
  wait_event,
  query,
  CASE
    WHEN state IN ('active') AND query_start IS NOT NULL
      THEN EXTRACT(EPOCH FROM (clock_timestamp() - query_start)) * 1000
    ELSE NULL
  END AS duration_ms,
  pid = pg_backend_pid() AS is_current,
  array_to_string(pg_blocking_pids(pid), ',') AS blocked_by,
  (pg_has_role(current_user, 'pg_read_all_stats', 'member') OR (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)) AS can_see_all
FROM pg_stat_activity
WHERE backend_type = 'client backend'
ORDER BY duration_ms DESC NULLS LAST, query_start DESC NULLS LAST`;

export interface ActivitySession {
  pid: number;
  state: string | null;
  user: string | null;
  database: string | null;
  applicationName: string | null;
  clientAddr: string | null;
  backendStart: string | null;
  queryStart: string | null;
  stateChange: string | null;
  waitEventType: string | null;
  waitEvent: string | null;
  query: string | null;
  durationMs: number | null;
  isCurrent: boolean;
  blockedBy: number[];
  /** False when the role lacks pg_read_all_stats, so other roles' sessions are hidden. */
  canSeeAll: boolean;
}

const nullable = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export function parseActivity(rows: Row[]): ActivitySession[] {
  return rows.map((r) => ({
    pid: num(r.pid),
    state: nullable(r.state),
    user: nullable(r.user),
    database: nullable(r.database),
    applicationName: nullable(r.application_name),
    clientAddr: nullable(r.client_addr),
    backendStart: nullable(r.backend_start),
    queryStart: nullable(r.query_start),
    stateChange: nullable(r.state_change),
    waitEventType: nullable(r.wait_event_type),
    waitEvent: nullable(r.wait_event),
    query: nullable(r.query),
    durationMs: numOrNull(r.duration_ms),
    isCurrent: bool(r.is_current),
    blockedBy: str(r.blocked_by)
      .split(',')
      .map((p) => Number(p))
      .filter((p) => Number.isInteger(p) && p > 0),
    canSeeAll: r.can_see_all === undefined ? true : bool(r.can_see_all),
  }));
}

/**
 * Without pg_read_all_stats (or pg_monitor) Postgres shows a role only its
 * own sessions, so the list is silently incomplete.
 */
export function activityIsPartial(rows: readonly ActivitySession[]): boolean {
  return rows.some((r) => !r.canSeeAll);
}

export interface LockNode {
  pid: number;
  session: ActivitySession | undefined;
  /** Sessions this one waits on (present in the snapshot or not). */
  blockers: number[];
  /** Sessions waiting on this one. */
  waiters: number[];
}

export interface LockGraph {
  nodes: Map<number, LockNode>;
  /** Blockers that are not themselves blocked: the heads of each chain. */
  roots: number[];
}

/** Build the who-blocks-whom graph from one activity snapshot. */
export function buildLockGraph(sessions: readonly ActivitySession[]): LockGraph {
  const nodes = new Map<number, LockNode>();
  const ensure = (pid: number, s?: ActivitySession): LockNode => {
    let n = nodes.get(pid);
    if (!n) {
      n = { pid, session: s, blockers: [], waiters: [] };
      nodes.set(pid, n);
    } else if (s && !n.session) {
      n.session = s;
    }
    return n;
  };
  for (const s of sessions) {
    if (s.blockedBy.length === 0) continue;
    const waiter = ensure(s.pid, s);
    for (const b of s.blockedBy) {
      const blocker = ensure(
        b,
        sessions.find((x) => x.pid === b),
      );
      if (!waiter.blockers.includes(b)) waiter.blockers.push(b);
      if (!blocker.waiters.includes(s.pid)) blocker.waiters.push(s.pid);
    }
  }
  const roots = [...nodes.values()]
    .filter((n) => n.blockers.length === 0 && n.waiters.length > 0)
    .map((n) => n.pid)
    .sort((a, b) => a - b);
  return { nodes, roots };
}

/**
 * The blocking chain around `pid`: everything it waits on (transitively)
 * and everything waiting on it. Used to highlight a selected session.
 */
export function blockingChain(graph: LockGraph, pid: number): Set<number> {
  const out = new Set<number>();
  if (!graph.nodes.has(pid)) return out;
  const walk = (start: number, next: (n: LockNode) => number[]) => {
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop() as number;
      if (out.has(cur)) continue;
      out.add(cur);
      const n = graph.nodes.get(cur);
      if (n) stack.push(...next(n));
    }
  };
  walk(pid, (n) => n.blockers);
  const upstream = new Set(out);
  out.clear();
  walk(pid, (n) => n.waiters);
  for (const p of upstream) out.add(p);
  return out;
}

export interface LockTreeRow {
  /** Unique per position in the tree (a pid can appear under several blockers). */
  key: string;
  pid: number;
  depth: number;
  node: LockNode;
}

/** Flatten the graph into an indented tree (roots first); cycles are cut. */
export function lockTreeRows(graph: LockGraph): LockTreeRow[] {
  const rows: LockTreeRow[] = [];
  const visit = (pid: number, depth: number, path: Set<number>) => {
    const node = graph.nodes.get(pid);
    if (!node || path.has(pid)) return;
    rows.push({ key: [...path, pid].join('>'), pid, depth, node });
    const next = new Set(path).add(pid);
    for (const w of [...node.waiters].sort((a, b) => a - b)) visit(w, depth + 1, next);
  };
  let roots = graph.roots;
  if (roots.length === 0 && graph.nodes.size > 0) {
    // Pure deadlock cycle: no head. Start from the lowest pid.
    roots = [Math.min(...graph.nodes.keys())];
  }
  for (const r of roots) visit(r, 0, new Set());
  return rows;
}
