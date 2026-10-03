import {
  type CheckResult,
  type HealthFinding,
  fmtBytes,
  fmtDurationMs,
  fmtInt,
  fmtPct,
  num,
  str,
  worstStatus,
} from './types';

export interface SampledKey {
  key: string;
  type: string;
  bytes: number | null;
  ttlMs?: number | null;
}

// ─── Big keys ────────────────────────────────────────────────────────

export const BIG_KEY_WARN_BYTES = 1024 * 1024;
export const BIG_KEY_CRIT_BYTES = 50 * 1024 * 1024;

export function topBigKeys(samples: readonly SampledKey[], limit = 20): SampledKey[] {
  return samples
    .filter((s) => s.bytes !== null)
    .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
    .slice(0, limit);
}

export function interpretBigKeys(samples: readonly SampledKey[], scanned: number): CheckResult {
  const top = topBigKeys(samples);
  const findings: HealthFinding[] = [];
  for (const s of top) {
    const bytes = s.bytes ?? 0;
    if (bytes < BIG_KEY_WARN_BYTES) break;
    findings.push({
      id: `bigkey:${s.key}`,
      status: bytes >= BIG_KEY_CRIT_BYTES ? 'crit' : 'warn',
      title: `${s.key} (${s.type}) uses ${fmtBytes(bytes)}`,
      evidence:
        'Big keys block the single-threaded server while being read, deleted, expired or replicated. Split the value or let UNLINK reclaim it in the background.',
      action: {
        label: 'Delete in the background',
        note: `UNLINK ${JSON.stringify(s.key)} frees the memory without blocking. Run it from the Redis CLI after checking nothing reads this key.`,
        destructive: true,
      },
    });
  }
  return {
    status: worstStatus(findings.map((f) => f.status)),
    summary:
      scanned === 0
        ? 'Not sampled yet'
        : findings.length
          ? `${findings.length} big key(s)`
          : 'No big keys in the sample',
    findings,
    note: `Sampled ${fmtInt(scanned)} keys by SCAN; sizes come from MEMORY USAGE, so rare giants may be missed.`,
  };
}

// ─── Hot keys (LFU) ──────────────────────────────────────────────────

export interface HotKey {
  key: string;
  /** OBJECT FREQ: the logarithmic LFU counter, 0-255. */
  freq: number;
}

export function isLfuError(message: string): boolean {
  return /LFU/i.test(message);
}

export function interpretHotKeys(hot: readonly HotKey[], lfuEnabled: boolean): CheckResult {
  if (!lfuEnabled) {
    return {
      status: 'unknown',
      summary: 'LFU is off',
      findings: [
        {
          id: 'hot-lfu-off',
          status: 'unknown',
          title: 'Hot keys need an LFU eviction policy',
          evidence:
            'OBJECT FREQ only works when maxmemory-policy is allkeys-lfu or volatile-lfu. Enabling it changes eviction behaviour, so Plasma does not do it for you.',
          action: {
            label: 'How to enable',
            note: 'CONFIG SET maxmemory-policy allkeys-lfu (and set maxmemory).',
          },
        },
      ],
    };
  }
  const sorted = [...hot].sort((a, b) => b.freq - a.freq).slice(0, 20);
  const findings: HealthFinding[] = sorted
    .filter((h) => h.freq >= 200)
    .map((h) => ({
      id: `hotkey:${h.key}`,
      status: 'warn' as const,
      title: `${h.key} is very hot (LFU counter ${h.freq}/255)`,
      evidence:
        'The counter is logarithmic: values near 255 mean millions of recent hits. Consider client-side caching or sharding the key.',
    }));
  return {
    status: worstStatus(findings.map((f) => f.status)),
    summary: sorted[0] ? `Hottest: ${sorted[0].key}` : 'No data',
    findings,
    table: {
      columns: [
        { key: 'key', label: 'Key', width: 360 },
        { key: 'freq', label: 'LFU counter', align: 'right', width: 110 },
      ],
      rows: sorted.map((h) => ({ key: h.key, freq: String(h.freq) })),
    },
  };
}

// ─── Memory treemap by prefix ────────────────────────────────────────

export interface PrefixNode {
  name: string;
  path: string;
  bytes: number;
  count: number;
  children: PrefixNode[];
}

/**
 * Group sampled keys into a tree by splitting on `delimiter`. The last
 * segment is the key itself, so a leaf only appears as a node when a key
 * lives directly under a prefix (`a:b` adds bytes to `a`; its leaf is merged).
 */
export function buildPrefixTree(
  samples: readonly SampledKey[],
  opts: { delimiter?: string; maxDepth?: number } = {},
): PrefixNode {
  const delimiter = opts.delimiter ?? ':';
  const maxDepth = opts.maxDepth ?? 3;
  const root: PrefixNode = { name: '(all keys)', path: '', bytes: 0, count: 0, children: [] };
  for (const s of samples) {
    if (s.bytes === null) continue;
    const parts = s.key.split(delimiter);
    // The final segment is the key's own name, never a prefix.
    const prefixes = parts.length > 1 ? parts.slice(0, -1) : ['(no prefix)'];
    root.bytes += s.bytes;
    root.count += 1;
    let node = root;
    const used = prefixes.slice(0, maxDepth);
    let path = '';
    for (const seg of used) {
      path = path ? `${path}${delimiter}${seg}` : seg;
      let child = node.children.find((c) => c.name === seg);
      if (!child) {
        child = { name: seg, path, bytes: 0, count: 0, children: [] };
        node.children.push(child);
      }
      child.bytes += s.bytes;
      child.count += 1;
      node = child;
    }
  }
  const sortRec = (n: PrefixNode) => {
    n.children.sort((a, b) => b.bytes - a.bytes);
    n.children.forEach(sortRec);
  };
  sortRec(root);
  return root;
}

export function topPrefixes(root: PrefixNode, limit = 15): PrefixNode[] {
  return [...root.children].sort((a, b) => b.bytes - a.bytes).slice(0, limit);
}

export interface TreemapRect<T> {
  item: T;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Squarified treemap (Bruls et al.) of items with positive `value`, inside a w x h box. */
export function squarify<T>(
  items: readonly T[],
  value: (t: T) => number,
  w: number,
  h: number,
): Array<TreemapRect<T>> {
  const list = items.filter((i) => value(i) > 0).sort((a, b) => value(b) - value(a));
  const total = list.reduce((a, i) => a + value(i), 0);
  const out: Array<TreemapRect<T>> = [];
  if (total <= 0 || w <= 0 || h <= 0) return out;
  const scale = (w * h) / total;
  let x = 0;
  let y = 0;
  let rw = w;
  let rh = h;
  let row: Array<{ item: T; area: number }> = [];

  const worst = (areas: number[], side: number): number => {
    const s = areas.reduce((a, b) => a + b, 0);
    const max = Math.max(...areas);
    const min = Math.min(...areas);
    return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
  };
  const flush = () => {
    if (row.length === 0) return;
    const s = row.reduce((a, r) => a + r.area, 0);
    if (rw >= rh) {
      const colW = s / rh;
      let cy = y;
      for (const r of row) {
        const ih = r.area / colW;
        out.push({ item: r.item, x, y: cy, w: colW, h: ih });
        cy += ih;
      }
      x += colW;
      rw -= colW;
    } else {
      const rowH = s / rw;
      let cx = x;
      for (const r of row) {
        const iw = r.area / rowH;
        out.push({ item: r.item, x: cx, y, w: iw, h: rowH });
        cx += iw;
      }
      y += rowH;
      rh -= rowH;
    }
    row = [];
  };

  for (const item of list) {
    const area = value(item) * scale;
    const side = Math.min(rw, rh);
    const areas = row.map((r) => r.area);
    if (row.length === 0 || worst([...areas, area], side) <= worst(areas, side)) {
      row.push({ item, area });
    } else {
      flush();
      row.push({ item, area });
    }
  }
  flush();
  return out;
}

// ─── Latency ─────────────────────────────────────────────────────────

export interface LatencyEvent {
  event: string;
  lastSeen: number;
  latestMs: number;
  maxMs: number;
}

/** LATENCY LATEST reply: [[event, unix ts, latest ms, max ms], ...]. */
export function parseLatencyLatest(reply: unknown): LatencyEvent[] {
  if (!Array.isArray(reply)) return [];
  const out: LatencyEvent[] = [];
  for (const e of reply) {
    if (!Array.isArray(e)) continue;
    out.push({ event: str(e[0]), lastSeen: num(e[1]), latestMs: num(e[2]), maxMs: num(e[3]) });
  }
  return out.sort((a, b) => b.maxMs - a.maxMs);
}

export function interpretLatency(
  events: readonly LatencyEvent[],
  monitorEnabled = true,
): CheckResult {
  if (events.length === 0) {
    return {
      status: 'ok',
      summary: monitorEnabled ? 'No latency spikes recorded' : 'Latency monitor is off',
      findings: monitorEnabled
        ? []
        : [
            {
              id: 'latency-off',
              status: 'unknown',
              title: 'Latency monitor is off',
              evidence:
                'latency-monitor-threshold is 0, so no spikes are recorded. Set it to e.g. 100 (ms) to enable LATENCY LATEST / DOCTOR.',
              action: { label: 'How to enable', note: 'CONFIG SET latency-monitor-threshold 100' },
            },
          ],
    };
  }
  const findings: HealthFinding[] = events.map((e) => ({
    id: `latency:${e.event}`,
    status: e.maxMs >= 1000 ? 'crit' : e.maxMs >= 100 ? 'warn' : 'ok',
    title: `${e.event}: worst ${fmtDurationMs(e.maxMs)}, latest ${fmtDurationMs(e.latestMs)}`,
    evidence: `Last spike ${new Date(e.lastSeen * 1000).toISOString()}. See the LATENCY DOCTOR report for causes.`,
  }));
  return {
    status: worstStatus(findings.map((f) => f.status)),
    summary: `${events.length} event(s), worst ${fmtDurationMs(events[0]?.maxMs ?? 0)}`,
    findings,
  };
}

// ─── Slowlog summary ─────────────────────────────────────────────────

export interface SlowEntry {
  durationUs: number;
  argv: readonly string[];
}

export interface SlowSummaryRow {
  command: string;
  count: number;
  totalUs: number;
  maxUs: number;
}

export function summarizeSlowlog(entries: readonly SlowEntry[]): SlowSummaryRow[] {
  const by = new Map<string, SlowSummaryRow>();
  for (const e of entries) {
    const head = (e.argv[0] ?? '?').toUpperCase();
    const command =
      ['CONFIG', 'CLIENT', 'MEMORY', 'XINFO', 'OBJECT'].includes(head) && e.argv[1]
        ? `${head} ${e.argv[1].toUpperCase()}`
        : head;
    const row = by.get(command) ?? { command, count: 0, totalUs: 0, maxUs: 0 };
    row.count += 1;
    row.totalUs += e.durationUs;
    row.maxUs = Math.max(row.maxUs, e.durationUs);
    by.set(command, row);
  }
  return [...by.values()].sort((a, b) => b.totalUs - a.totalUs);
}

export function interpretSlowlog(entries: readonly SlowEntry[]): CheckResult {
  const rows = summarizeSlowlog(entries);
  const findings: HealthFinding[] = rows
    .filter((r) => r.maxUs >= 100_000)
    .map((r) => ({
      id: `slow:${r.command}`,
      status: r.maxUs >= 1_000_000 ? ('crit' as const) : ('warn' as const),
      title: `${r.command} appears ${r.count}x in the slow log (worst ${fmtDurationMs(r.maxUs / 1000)})`,
      evidence: `${fmtDurationMs(r.totalUs / 1000)} total. Commands such as KEYS, SMEMBERS or HGETALL on big keys scan in O(n); use SCAN / HSCAN.`,
    }));
  return {
    status: worstStatus(findings.map((f) => f.status)),
    summary: entries.length ? `${entries.length} slow command(s)` : 'Slow log is empty',
    findings,
    table: {
      columns: [
        { key: 'command', label: 'Command', width: 200 },
        { key: 'count', label: 'Count', align: 'right', width: 80 },
        { key: 'total', label: 'Total', align: 'right', width: 110 },
        { key: 'max', label: 'Worst', align: 'right', width: 110 },
      ],
      rows: rows.map((r) => ({
        command: r.command,
        count: String(r.count),
        total: fmtDurationMs(r.totalUs / 1000),
        max: fmtDurationMs(r.maxUs / 1000),
      })),
    },
  };
}

// ─── Clients ─────────────────────────────────────────────────────────

export interface RedisClient {
  id: string;
  addr: string;
  name: string;
  ageS: number;
  idleS: number;
  db: string;
  cmd: string;
  flags: string;
  omem: number;
  totMem: number | null;
}

/** CLIENT LIST reply: one `key=value ...` line per client. */
export function parseClientList(reply: unknown): RedisClient[] {
  const text = typeof reply === 'string' ? reply : '';
  const out: RedisClient[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const f: Record<string, string> = {};
    for (const part of line.trim().split(' ')) {
      const i = part.indexOf('=');
      if (i > 0) f[part.slice(0, i)] = part.slice(i + 1);
    }
    if (!f.id) continue;
    out.push({
      id: f.id,
      addr: f.addr ?? '',
      name: f.name ?? '',
      ageS: num(f.age),
      idleS: num(f.idle),
      db: f.db ?? '',
      cmd: f.cmd ?? '',
      flags: f.flags ?? '',
      omem: num(f.omem),
      totMem: f['tot-mem'] !== undefined ? num(f['tot-mem']) : null,
    });
  }
  return out;
}

export function interpretClients(
  clients: readonly RedisClient[],
  maxClients?: number,
): CheckResult {
  const findings: HealthFinding[] = [];
  for (const c of clients) {
    if (c.omem >= 32 * 1024 * 1024) {
      findings.push({
        id: `client-omem:${c.id}`,
        status: 'crit',
        title: `Client ${c.id} (${c.addr}) has ${fmtBytes(c.omem)} of unsent output`,
        evidence: 'A slow consumer (often pub/sub) makes the server buffer replies in memory.',
        action: { label: 'Kill client', note: `CLIENT KILL ID ${c.id}`, destructive: true },
      });
    }
    if (c.flags.includes('b') && c.idleS > 3600) {
      findings.push({
        id: `client-blocked:${c.id}`,
        status: 'warn',
        title: `Client ${c.id} has been blocked for ${fmtDurationMs(c.idleS * 1000)}`,
        evidence: `${c.addr}, command ${c.cmd}. Normal for queue workers, suspicious otherwise.`,
      });
    }
  }
  if (maxClients && clients.length >= maxClients * 0.8) {
    findings.push({
      id: 'clients-limit',
      status: clients.length >= maxClients * 0.95 ? 'crit' : 'warn',
      title: `${clients.length} of ${maxClients} client slots used`,
      evidence: 'New connections are refused at maxclients.',
    });
  }
  return {
    status: worstStatus(findings.map((f) => f.status)),
    summary: `${clients.length} client(s)`,
    findings,
  };
}

export function clientKillCommand(id: string): string[] | null {
  return /^\d+$/.test(id) ? ['CLIENT', 'KILL', 'ID', id] : null;
}

// ─── Memory (INFO memory) ────────────────────────────────────────────

/** Parse `INFO` text (`key:value` lines) into a map. */
export function parseInfo(text: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof text !== 'string') return out;
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

export function interpretMemory(info: Record<string, string>): CheckResult {
  const used = num(info.used_memory);
  const max = num(info.maxmemory);
  const frag = num(info.mem_fragmentation_ratio);
  const evicted = num(info.evicted_keys);
  const findings: HealthFinding[] = [];
  if (max > 0) {
    const pct = (used / max) * 100;
    if (pct >= 90) {
      findings.push({
        id: 'mem-limit',
        status: pct >= 98 ? 'crit' : 'warn',
        title: `Memory is ${fmtPct(pct, 0)} of maxmemory`,
        evidence: `${fmtBytes(used)} of ${fmtBytes(max)} (policy ${info.maxmemory_policy ?? 'unknown'}). ${
          evicted > 0 ? `${fmtInt(evicted)} keys evicted so far. ` : ''
        }With noeviction, writes start failing at the limit.`,
      });
    }
  }
  if (frag > 1.5 && used > 100 * 1024 * 1024) {
    findings.push({
      id: 'mem-frag',
      status: 'warn',
      title: `Fragmentation ratio is ${frag.toFixed(2)}`,
      evidence:
        'The process holds much more memory than the data needs; active defragmentation or a restart reclaims it.',
    });
  } else if (frag > 0 && frag < 1 && used > 100 * 1024 * 1024) {
    findings.push({
      id: 'mem-swap',
      status: 'crit',
      title: `Fragmentation ratio is ${frag.toFixed(2)}, below 1`,
      evidence: 'Redis may be swapping to disk, which is catastrophic for latency.',
    });
  }
  return {
    status: worstStatus(findings.map((f) => f.status)),
    summary: max > 0 ? `${fmtBytes(used)} of ${fmtBytes(max)}` : `${fmtBytes(used)} (no limit)`,
    findings,
  };
}
