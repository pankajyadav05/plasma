import {
  type CheckResult,
  type HealthFinding,
  fmtBytes,
  fmtInt,
  fmtPct,
  num,
  str,
  worstStatus,
} from './types';

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// ─── Cluster health and red/yellow indices ───────────────────────────

export interface UnassignedShard {
  index: string;
  shard: number;
  primary: boolean;
  reason: string;
}

/** `_cat/shards?format=json&h=index,shard,prirep,state,unassigned.reason`. */
export function parseUnassignedShards(cat: unknown): UnassignedShard[] {
  return asArr(cat)
    .filter(isObj)
    .filter((r) => str(r.state) === 'UNASSIGNED')
    .map((r) => ({
      index: str(r.index),
      shard: num(r.shard),
      primary: str(r.prirep) === 'p',
      reason: str(r['unassigned.reason']),
    }));
}

export const UNASSIGNED_REASON_TEXT: Record<string, string> = {
  INDEX_CREATED: 'The index was just created and its shards are not allocated yet.',
  CLUSTER_RECOVERED: 'The cluster restarted and is still recovering this shard.',
  INDEX_REOPENED: 'The index was reopened.',
  DANGLING_INDEX_IMPORTED: 'The index was imported from disk.',
  NEW_INDEX_RESTORED: 'The index is being restored from a snapshot.',
  EXISTING_INDEX_RESTORED: 'The index is being restored from a snapshot.',
  REPLICA_ADDED: 'A replica was added and has not been allocated yet.',
  ALLOCATION_FAILED: 'Allocation was attempted and failed (see the decider details below).',
  NODE_LEFT: 'The node holding this shard left the cluster.',
  REINITIALIZED: 'The shard was reinitialised.',
  REROUTE_CANCELLED: 'A reroute command cancelled the allocation.',
  REALLOCATED_REPLICA: 'A better node was found for this replica.',
  PRIMARY_FAILED: 'The primary failed while this replica was initialising.',
  FORCED_EMPTY_PRIMARY: 'An empty primary was forced.',
  MANUAL_ALLOCATION: 'The shard was allocated manually.',
};

export const DECIDER_TEXT: Record<string, string> = {
  disk_threshold: 'The node is above its disk watermark, so no new shards are allocated to it.',
  same_shard:
    'The node already holds a copy of this shard; replicas must live on a different node.',
  filter: 'An allocation filter (include / exclude / require) rules this node out.',
  awareness: 'Allocation awareness (zone / rack) forbids this placement.',
  shards_limit:
    'The per-node shard limit (total_shards_per_node or cluster.max_shards_per_node) is reached.',
  replica_after_primary_active:
    'The primary is not active yet, so its replica cannot be allocated.',
  max_retry: 'Allocation failed too many times and stopped retrying.',
  node_version: 'The node runs an older version than the shard source.',
  enable: 'Shard allocation is disabled (cluster.routing.allocation.enable).',
  throttling: 'Too many recoveries are already running; this one waits its turn.',
  data_tier: 'No node with the required data tier is available.',
  resize: 'A shrink / split source shard is not on the right node.',
  restore_in_progress: 'A snapshot restore is still running.',
  snapshot_in_progress: 'A snapshot is running on this shard.',
  node_shutdown: 'The node is marked for shutdown.',
};

export interface AllocationExplanation {
  index: string;
  shard: number;
  primary: boolean;
  currentState: string;
  reason: string;
  /** Plain-language sentences, most useful first. */
  causes: string[];
  fix?: string;
}

/** `_cluster/allocation/explain` response for one shard. */
export function explainAllocation(res: unknown): AllocationExplanation | null {
  if (!isObj(res) || !str(res.index)) return null;
  const info = isObj(res.unassigned_info) ? res.unassigned_info : {};
  const reasonCode = str(info.reason);
  const causes: string[] = [];
  const seen = new Set<string>();
  let fix: string | undefined;
  const decisions = asArr(res.node_allocation_decisions).filter(isObj);
  for (const d of decisions) {
    for (const dec of asArr(d.deciders).filter(isObj)) {
      if (str(dec.decision) !== 'NO') continue;
      const name = str(dec.decider);
      const text = DECIDER_TEXT[name] ?? str(dec.explanation);
      const where = str(d.node_name);
      const line = where ? `${where}: ${text}` : text;
      if (!seen.has(line)) {
        seen.add(line);
        causes.push(line);
      }
      if (name === 'max_retry') {
        fix = 'POST _cluster/reroute?retry_failed=true once the underlying cause is fixed.';
      } else if (name === 'disk_threshold' && !fix) {
        fix =
          'Free disk space, add a node, or raise the watermarks temporarily (cluster.routing.allocation.disk.watermark.*).';
      } else if (name === 'same_shard' && !fix) {
        fix = 'Add a data node, or lower index.number_of_replicas.';
      } else if (name === 'enable' && !fix) {
        fix = 'Set cluster.routing.allocation.enable back to "all".';
      }
    }
  }
  const explanation = str(res.allocate_explanation) || str(res.can_allocate);
  if (causes.length === 0 && explanation) causes.push(explanation);
  if (causes.length === 0 && UNASSIGNED_REASON_TEXT[reasonCode])
    causes.push(UNASSIGNED_REASON_TEXT[reasonCode]);
  return {
    index: str(res.index),
    shard: num(res.shard),
    primary: res.primary === true,
    currentState: str(res.current_state),
    reason: UNASSIGNED_REASON_TEXT[reasonCode] ?? reasonCode,
    causes,
    fix,
  };
}

export interface IndexHealth {
  name: string;
  status: string;
  unassigned: number;
  initializing: number;
  relocating: number;
}

/** `_cluster/health?level=indices`. */
export function parseIndexHealth(health: unknown): IndexHealth[] {
  if (!isObj(health) || !isObj(health.indices)) return [];
  return Object.entries(health.indices).map(([name, v]) => {
    const o = isObj(v) ? v : {};
    return {
      name,
      status: str(o.status),
      unassigned: num(o.unassigned_shards),
      initializing: num(o.initializing_shards),
      relocating: num(o.relocating_shards),
    };
  });
}

const STATUS_MAP: Record<string, 'ok' | 'warn' | 'crit' | 'unknown'> = {
  green: 'ok',
  yellow: 'warn',
  red: 'crit',
};

export function interpretClusterHealth(
  health: unknown,
  explanations: readonly AllocationExplanation[],
  unassigned: readonly UnassignedShard[] = [],
): CheckResult {
  if (!isObj(health)) return { status: 'unknown', summary: 'No data', findings: [] };
  const color = str(health.status);
  const status = STATUS_MAP[color] ?? 'unknown';
  const findings: HealthFinding[] = [];
  const indices = parseIndexHealth(health).filter((i) => i.status !== 'green');
  for (const i of indices) {
    const shards = unassigned.filter((s) => s.index === i.name);
    const primaries = shards.filter((s) => s.primary).length;
    const exp = explanations.find((e) => e.index === i.name);
    findings.push({
      id: `index:${i.name}`,
      status: i.status === 'red' ? 'crit' : 'warn',
      title:
        i.status === 'red'
          ? `${i.name} is red: ${primaries || 'a'} primary shard(s) unassigned, data is unavailable`
          : `${i.name} is yellow: ${i.unassigned} replica shard(s) unassigned`,
      evidence: exp
        ? `${exp.reason} ${exp.causes.join(' ')}`.trim()
        : shards[0]
          ? (UNASSIGNED_REASON_TEXT[shards[0].reason] ?? shards[0].reason)
          : `${i.unassigned} unassigned, ${i.initializing} initialising, ${i.relocating} relocating.`,
      action: exp?.fix ? { label: 'Suggested fix', note: exp.fix } : undefined,
    });
  }
  if (findings.length === 0 && color !== 'green') {
    findings.push({
      id: 'cluster',
      status,
      title: `Cluster is ${color}`,
      evidence: `${num(health.unassigned_shards)} unassigned, ${num(health.initializing_shards)} initialising, ${num(health.relocating_shards)} relocating shards.`,
    });
  }
  if (num(health.number_of_pending_tasks) > 50) {
    findings.push({
      id: 'pending-tasks',
      status: 'warn',
      title: `${fmtInt(num(health.number_of_pending_tasks))} pending cluster tasks`,
      evidence: 'The master is backed up; mapping updates and shard moves are queueing.',
    });
  }
  return {
    status: worstStatus([status, ...findings.map((f) => f.status)]),
    summary: `${color || 'unknown'}: ${num(health.number_of_nodes)} node(s), ${num(health.unassigned_shards)} unassigned`,
    findings,
  };
}

// ─── Disk watermarks per node ────────────────────────────────────────

export interface Watermarks {
  low: string;
  high: string;
  floodStage: string;
}

export const DEFAULT_WATERMARKS: Watermarks = { low: '85%', high: '90%', floodStage: '95%' };

/** `_cluster/settings?include_defaults=true&flat_settings=true`. */
export function parseWatermarks(settings: unknown): Watermarks {
  const out = { ...DEFAULT_WATERMARKS };
  if (!isObj(settings)) return out;
  const pick = (key: string): string | null => {
    for (const scope of ['transient', 'persistent', 'defaults']) {
      const s = settings[scope];
      if (isObj(s) && s[key] !== undefined) return str(s[key]);
    }
    return null;
  };
  out.low = pick('cluster.routing.allocation.disk.watermark.low') ?? out.low;
  out.high = pick('cluster.routing.allocation.disk.watermark.high') ?? out.high;
  out.floodStage = pick('cluster.routing.allocation.disk.watermark.flood_stage') ?? out.floodStage;
  return out;
}

/** "85%" -> 85; byte-size watermarks ("50gb" free) resolve against the disk total. */
export function watermarkUsedPct(value: string, totalBytes: number): number | null {
  const v = value.trim().toLowerCase();
  if (v.endsWith('%')) return Number.parseFloat(v);
  const m = /^([\d.]+)(b|kb|mb|gb|tb)$/.exec(v);
  if (!m || totalBytes <= 0) return null;
  const mult = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }[m[2] as 'b'];
  const free = Number(m[1]) * mult;
  return Math.max(0, 100 - (free / totalBytes) * 100);
}

export interface NodeDisk {
  node: string;
  usedPct: number;
  usedBytes: number;
  totalBytes: number;
  shards: number;
}

/** `_cat/allocation?format=json&bytes=b`. UNASSIGNED rows carry no disk data. */
export function parseNodeDisks(cat: unknown): NodeDisk[] {
  return asArr(cat)
    .filter(isObj)
    .filter(
      (r) =>
        str(r.node) !== 'UNASSIGNED' && r['disk.total'] !== undefined && r['disk.total'] !== null,
    )
    .map((r) => ({
      node: str(r.node),
      usedPct: num(r['disk.percent']),
      usedBytes: num(r['disk.used']),
      totalBytes: num(r['disk.total']),
      shards: num(r.shards),
    }));
}

export function interpretDisks(disks: readonly NodeDisk[], marks: Watermarks): CheckResult {
  const findings: HealthFinding[] = [];
  for (const d of disks) {
    const low = watermarkUsedPct(marks.low, d.totalBytes) ?? 85;
    const high = watermarkUsedPct(marks.high, d.totalBytes) ?? 90;
    const flood = watermarkUsedPct(marks.floodStage, d.totalBytes) ?? 95;
    if (d.usedPct >= flood) {
      findings.push({
        id: `disk:${d.node}`,
        status: 'crit',
        title: `${d.node} is past the flood-stage watermark (${fmtPct(d.usedPct, 0)} used)`,
        evidence: `Indices with a shard on this node are set read-only (index.blocks.read_only_allow_delete). ${fmtBytes(d.usedBytes)} of ${fmtBytes(d.totalBytes)} used.`,
        action: {
          label: 'Free space',
          note: 'Delete old indices or add disk, then clear the block: PUT _all/_settings {"index.blocks.read_only_allow_delete": null}',
        },
      });
    } else if (d.usedPct >= high) {
      findings.push({
        id: `disk:${d.node}`,
        status: 'crit',
        title: `${d.node} is past the high watermark (${fmtPct(d.usedPct, 0)} used)`,
        evidence: 'OpenSearch is moving shards off this node and will not allocate new ones here.',
      });
    } else if (d.usedPct >= low) {
      findings.push({
        id: `disk:${d.node}`,
        status: 'warn',
        title: `${d.node} is past the low watermark (${fmtPct(d.usedPct, 0)} used)`,
        evidence: 'No new shards are allocated to this node.',
      });
    }
  }
  return {
    status: worstStatus(findings.map((f) => f.status)),
    summary: disks.length
      ? `${disks.length} node(s), max ${fmtPct(Math.max(...disks.map((d) => d.usedPct)), 0)} used`
      : 'No disk data',
    findings,
    note: `Watermarks: low ${marks.low}, high ${marks.high}, flood stage ${marks.floodStage}.`,
    table: {
      columns: [
        { key: 'node', label: 'Node', width: 200 },
        { key: 'used', label: 'Disk used', align: 'right', width: 110 },
        { key: 'size', label: 'Used / total', align: 'right', width: 160 },
        { key: 'shards', label: 'Shards', align: 'right', width: 80 },
      ],
      rows: disks.map((d) => ({
        node: d.node,
        used: fmtPct(d.usedPct, 0),
        size: `${fmtBytes(d.usedBytes)} / ${fmtBytes(d.totalBytes)}`,
        shards: String(d.shards),
      })),
    },
  };
}

// ─── Hot threads ─────────────────────────────────────────────────────

export interface HotThreadSummary {
  node: string;
  topPercent: number;
  topThread: string;
  kind: string;
  count: number;
}

/** Summarise the plain-text `_nodes/hot_threads` report: busiest thread per node. */
export function summarizeHotThreads(text: string): HotThreadSummary[] {
  const out: HotThreadSummary[] = [];
  let cur: HotThreadSummary | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const nodeM = /^:::\s*\{([^}]*)\}/.exec(line);
    if (nodeM) {
      cur = { node: nodeM[1] ?? '', topPercent: 0, topThread: '', kind: '', count: 0 };
      out.push(cur);
      continue;
    }
    const thr = /^\s*([\d.]+)%\s*\(.*?\)\s*(\w+)\s+usage by thread '([^']+)'/.exec(line);
    if (thr && cur) {
      cur.count += 1;
      const pct = Number.parseFloat(thr[1] ?? '0');
      if (pct > cur.topPercent) {
        cur.topPercent = pct;
        cur.kind = thr[2] ?? '';
        cur.topThread = thr[3] ?? '';
      }
    }
  }
  return out;
}

export function interpretHotThreads(summary: readonly HotThreadSummary[]): CheckResult {
  const findings: HealthFinding[] = summary
    .filter((s) => s.topPercent >= 80)
    .map((s) => ({
      id: `hot:${s.node}`,
      status: 'warn' as const,
      title: `${s.node} has a thread at ${fmtPct(s.topPercent, 0)} ${s.kind}`,
      evidence: `${s.topThread}. ${/\[(search|write|bulk)\]/.test(s.topThread) ? 'Heavy search or indexing load; check slow queries and bulk sizes.' : 'Check the full hot_threads report for the stack.'}`,
    }));
  return {
    status: worstStatus(findings.map((f) => f.status)),
    summary: summary.length ? `${summary.length} node(s) sampled` : 'No data',
    findings,
    table: {
      columns: [
        { key: 'node', label: 'Node', width: 200 },
        { key: 'pct', label: 'Top thread', align: 'right', width: 100 },
        { key: 'thread', label: 'Thread', width: 380 },
      ],
      rows: summary.map((s) => ({
        node: s.node,
        pct: fmtPct(s.topPercent, 0),
        thread: s.topThread,
      })),
    },
  };
}
