import type { OsHit, OsMappingNode, OsSearchResult } from '@shared/protocol';
import type { OsPageCursor } from './os-store';

/**
 * Pure helpers for the OpenSearch views: value display, mapping and
 * aggregation flattening, request-body building and paging. Kept free of
 * React so they are unit-tested.
 */

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Compact count for 11px columns (1.2k, 3.4M). */
export function fmtCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

/** Cluster / index health → Badge tone. Green stays neutral (graphite). */
export function healthTone(health: string): 'neutral' | 'warn' | 'danger' {
  const h = health.toLowerCase();
  if (h === 'red') return 'danger';
  if (h === 'yellow') return 'warn';
  return 'neutral';
}

/** Sentence-case a word for display (distribution names, O23). */
export function capitalise(s: string): string {
  if (s === 'opensearch') return 'OpenSearch';
  if (s === 'elasticsearch') return 'Elasticsearch';
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

export function formatMs(ms: number): string {
  return `${Math.round(ms).toLocaleString()} ms`;
}

/** Total label: "12,000" or "≥ 10,000" when the cluster stopped counting (O3). */
export function totalLabel(r: Pick<OsSearchResult, 'total' | 'totalRelation'>): string {
  return `${r.totalRelation === 'gte' ? '≥ ' : ''}${r.total.toLocaleString()}`;
}

/** Requests that remove data or take indices offline — always confirmed. */
export function isDestructiveRequest(method: string, path: string): boolean {
  const m = method.toUpperCase();
  const p = path.split('?')[0] ?? '';
  if (m === 'DELETE') return true;
  return /\/(_delete_by_query|_close|_shrink|_split|_forcemerge|_update_by_query|_reindex|_restore)\b/.test(
    p.startsWith('/') ? p : `/${p}`,
  );
}

// ───────────── Values ─────────────

export function sourceOf(hit: OsHit): Record<string, unknown> {
  const s = hit.source;
  return s && typeof s === 'object' && !Array.isArray(s) ? (s as Record<string, unknown>) : {};
}

/**
 * Read a dotted path from `_source`, honouring both nested objects
 * (`{ user: { id } }`) and literal dotted keys (`{ "user.id": … }`).
 * Arrays of objects collect the leaf values.
 */
export function getPath(obj: unknown, path: string): unknown {
  if (obj === null || obj === undefined) return undefined;
  if (typeof obj !== 'object') return undefined;
  const rec = obj as Record<string, unknown>;
  if (path in rec) return rec[path];
  const dot = path.indexOf('.');
  if (dot < 0) return undefined;
  // Try the longest literal prefix first (`a.b` key before `a` → `b`).
  const parts = path.split('.');
  for (let i = parts.length - 1; i >= 1; i--) {
    const head = parts.slice(0, i).join('.');
    if (head in rec) {
      const next = rec[head];
      const rest = parts.slice(i).join('.');
      if (Array.isArray(next)) {
        const vals = next.map((v) => getPath(v, rest)).filter((v) => v !== undefined);
        return vals.length === 0 ? undefined : vals;
      }
      return getPath(next, rest);
    }
  }
  return undefined;
}

function isGeoObject(v: unknown): v is { lat: number; lon: number } {
  return (
    !!v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    typeof (v as { lat?: unknown }).lat === 'number' &&
    typeof (v as { lon?: unknown }).lon === 'number'
  );
}

/** geo_point in any accepted shape → "lat, lon" (F39). */
export function geoText(v: unknown): string | null {
  if (isGeoObject(v)) return `${v.lat}, ${v.lon}`;
  if (Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number')) {
    // GeoJSON order is [lon, lat].
    return `${v[1]}, ${v[0]}`;
  }
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && (v as { type?: unknown }).type === 'Point') {
    const c = (v as { coordinates?: unknown }).coordinates;
    if (Array.isArray(c) && c.length >= 2) return `${c[1]}, ${c[0]}`;
  }
  return null;
}

/** Compact one-line rendering for objects: `{a: 1, b: "x"}` (O22). */
function compact(v: unknown, depth = 0): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return depth === 0 ? v : JSON.stringify(v);
  if (typeof v !== 'object') return String(v);
  if (isGeoObject(v)) return `${v.lat}, ${v.lon}`;
  if (depth > 2) return Array.isArray(v) ? '[…]' : '{…}';
  if (Array.isArray(v)) return `[${v.map((x) => compact(x, depth + 1)).join(', ')}]`;
  const entries = Object.entries(v as Record<string, unknown>);
  return `{${entries.map(([k, x]) => `${k}: ${compact(x, depth + 1)}`).join(', ')}}`;
}

/** Grid text for a cell; `null` renders as the dim NULL word. */
export function displayValue(v: unknown, type?: string | null): string | null {
  if (v === null || v === undefined) return null;
  if (type === 'geo_point') {
    const g = Array.isArray(v) && v.some((x) => typeof x === 'object') ? null : geoText(v);
    if (g !== null) return g;
  }
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v) && v.every((x) => x === null || typeof x !== 'object')) {
    return v.map((x) => (x === null ? 'null' : String(x))).join(', ');
  }
  return compact(v);
}

/** Dotted-path flattening of plain objects; arrays and scalars stay as leaf values. */
export function flattenSource(
  obj: Record<string, unknown>,
  prefix = '',
  out: Record<string, unknown> = {},
): Record<string, unknown> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      !isGeoObject(v) &&
      Object.keys(v).length > 0
    ) {
      flattenSource(v as Record<string, unknown>, key, out);
    } else {
      out[key] = v;
    }
  }
  return out;
}

// ───────────── Mapping ─────────────

export interface LeafField {
  path: string;
  type: string | null;
  /** Keyword multi-field path, when declared (`title.keyword`). */
  keyword: string | null;
  conflicts: string[] | null;
}

/**
 * Leaf fields of a mapping as dotted paths (O5). Objects recurse; nested
 * fields recurse too (their leaves read as arrays). geo_point stays a leaf.
 */
export function mappingLeafFields(nodes: OsMappingNode[], prefix = ''): LeafField[] {
  const out: LeafField[] = [];
  for (const n of nodes) {
    const path = prefix ? `${prefix}.${n.name}` : n.name;
    if (n.children.length > 0) {
      out.push(...mappingLeafFields(n.children, path));
      continue;
    }
    const kw = n.multiFields?.find((m) => m.type === 'keyword');
    out.push({
      path,
      type: n.type,
      keyword: kw ? `${path}.${kw.name}` : null,
      conflicts: n.conflicts && n.conflicts.length > 1 ? n.conflicts : null,
    });
  }
  return out;
}

const PREFERRED_TYPES = new Set(['text', 'keyword', 'match_only_text', 'wildcard']);

/**
 * Default visible columns (F39): text-like fields first so titles and
 * labels show up, then everything else, up to `max`.
 */
export function pickDefaultColumns(fields: LeafField[], max = 8): string[] {
  if (fields.length <= max) return fields.map((f) => f.path);
  const first = fields.filter((f) => f.type && PREFERRED_TYPES.has(f.type));
  const rest = fields.filter((f) => !(f.type && PREFERRED_TYPES.has(f.type)));
  return [...first, ...rest].slice(0, max).map((f) => f.path);
}

/** Sortable path for a field: keyword sub-field for text, null when unsortable. */
export function sortPath(f: LeafField | undefined, path: string): string | null {
  if (!f) return path;
  if (f.type === 'text') return f.keyword;
  if (f.type && ['object', 'nested', 'geo_shape', 'binary', 'knn_vector'].includes(f.type)) {
    return null;
  }
  return path;
}

// ───────────── Request bodies + paging (O3, O19) ─────────────

export const TIME_RANGES: Array<{ value: string; label: string }> = [
  { value: 'now-15m', label: 'Last 15 minutes' },
  { value: 'now-1h', label: 'Last hour' },
  { value: 'now-24h', label: 'Last 24 hours' },
  { value: 'now-7d', label: 'Last 7 days' },
  { value: 'now-30d', label: 'Last 30 days' },
  { value: 'now-1y', label: 'Last year' },
];

export function buildDiscoverBody(opts: {
  queryString: string;
  size: number;
  sort: { field: string; dir: 'asc' | 'desc' } | null;
  timeField: string | null;
  timeRange: string | null;
}): Record<string, unknown> {
  const trimmed = opts.queryString.trim();
  const must: unknown[] = [];
  if (trimmed) must.push({ query_string: { query: trimmed } });
  if (opts.timeField && opts.timeRange) {
    must.push({ range: { [opts.timeField]: { gte: opts.timeRange, lte: 'now' } } });
  }
  const query =
    must.length === 0
      ? { match_all: {} }
      : must.length === 1
        ? must[0]
        : { bool: { filter: must } };
  // A trailing `_doc` gives every hit sort values, so paging can switch
  // to search_after past the 10,000 from/size window.
  const sort = opts.sort
    ? [{ [opts.sort.field]: { order: opts.sort.dir } }, { _doc: 'asc' }]
    : [{ _score: 'desc' }, { _doc: 'asc' }];
  return { size: opts.size, track_total_hits: true, query, sort };
}

/** Extract the `query` part of a DSL body (for field stats in DSL mode). */
export function queryOfBody(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { query?: unknown };
    return parsed && typeof parsed === 'object' && parsed.query
      ? JSON.stringify(parsed.query)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Re-issue the page-0 body at `cursor`. */
export function pageBody(baseBody: string, cursor: OsPageCursor): string {
  const body = JSON.parse(baseBody) as Record<string, unknown>;
  body.from = undefined;
  body.search_after = undefined;
  if (cursor.searchAfter) body.search_after = cursor.searchAfter;
  else if (cursor.from) body.from = cursor.from;
  return JSON.stringify(body);
}

/** Largest from+size OpenSearch allows by default (index.max_result_window). */
export const MAX_RESULT_WINDOW = 10_000;

/**
 * Cursor for the page after `page`, or null when there isn't one: prefer
 * search_after (any depth), fall back to from/size inside the window.
 */
export function nextPageCursor(
  result: OsSearchResult,
  page: number,
  size: number,
): OsPageCursor | null {
  const shown = page * size + result.hits.length;
  if (result.hits.length < size) return null;
  if (result.totalRelation === 'eq' && shown >= result.total) return null;
  const last = result.hits[result.hits.length - 1];
  if (last?.sort && last.sort.length > 0) return { searchAfter: last.sort };
  const from = (page + 1) * size;
  if (from + size > MAX_RESULT_WINDOW) return null;
  return { from };
}

// ───────────── Aggregations (O4) ─────────────

export interface AggRow {
  /** `by_country › by_severity` */
  path: string;
  key: string | null;
  docCount: number | null;
  value: string | null;
  depth: number;
}

function metricText(v: Record<string, unknown>): string | null {
  if ('value_as_string' in v && typeof v.value_as_string === 'string') return v.value_as_string;
  if ('value' in v) return v.value === null ? null : String(v.value);
  if ('values' in v && v.values && typeof v.values === 'object') {
    return Object.entries(v.values as Record<string, unknown>)
      .map(([k, x]) => `${k}: ${x}`)
      .join(', ');
  }
  const stats = ['count', 'min', 'max', 'avg', 'sum'].filter((k) => k in v);
  if (stats.length > 0) return stats.map((k) => `${k}: ${String(v[k])}`).join(', ');
  return null;
}

/**
 * Flatten an `aggregations` object into table rows: one row per bucket
 * (with its doc_count and nested metrics folded into `value`) and one row
 * per metric agg. Sub-aggregations follow their bucket, indented.
 */
export function flattenAggregations(aggs: unknown, parent = '', depth = 0): AggRow[] {
  if (!aggs || typeof aggs !== 'object') return [];
  const out: AggRow[] = [];
  for (const [name, raw] of Object.entries(aggs as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const agg = raw as Record<string, unknown>;
    const path = parent ? `${parent} › ${name}` : name;
    const buckets = agg.buckets;
    if (buckets && typeof buckets === 'object') {
      const list: Array<Record<string, unknown>> = Array.isArray(buckets)
        ? (buckets as Array<Record<string, unknown>>)
        : Object.entries(buckets as Record<string, Record<string, unknown>>).map(
            ([k, b]): Record<string, unknown> => ({ key: k, ...b }),
          );
      for (const b of list) {
        const key =
          typeof b.key_as_string === 'string'
            ? b.key_as_string
            : b.key === undefined
              ? null
              : typeof b.key === 'object'
                ? JSON.stringify(b.key)
                : String(b.key);
        const subs: Record<string, unknown> = {};
        const metrics: string[] = [];
        for (const [k, v] of Object.entries(b)) {
          if (
            [
              'key',
              'key_as_string',
              'doc_count',
              'from',
              'to',
              'from_as_string',
              'to_as_string',
            ].includes(k)
          ) {
            continue;
          }
          if (v && typeof v === 'object' && 'buckets' in (v as object)) subs[k] = v;
          else if (v && typeof v === 'object') {
            const m = metricText(v as Record<string, unknown>);
            if (m !== null) metrics.push(`${k}: ${m}`);
            else subs[k] = v;
          }
        }
        out.push({
          path,
          key,
          docCount: typeof b.doc_count === 'number' ? b.doc_count : null,
          value: metrics.length > 0 ? metrics.join(' · ') : null,
          depth,
        });
        out.push(...flattenAggregations(subs, `${path} [${key}]`, depth + 1));
      }
      continue;
    }
    const metric = metricText(agg);
    if (metric !== null || 'doc_count' in agg) {
      out.push({
        path,
        key: null,
        docCount: typeof agg.doc_count === 'number' ? agg.doc_count : null,
        value: metric,
        depth,
      });
    }
    // Single-bucket aggs (filter, nested, global) carry sub-aggs inline.
    const inner: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(agg)) {
      if (k === 'doc_count' || k === 'meta') continue;
      if (v && typeof v === 'object' && !Array.isArray(v)) inner[k] = v;
    }
    if (Object.keys(inner).length > 0 && metric === null) {
      out.push(...flattenAggregations(inner, path, depth + 1));
    }
  }
  return out;
}

// ───────────── Export (O19) ─────────────

function csvCell(s: string | null): string {
  if (s === null) return '';
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function hitsToCsv(hits: OsHit[], cols: string[]): string {
  const header = ['_index', '_id', ...cols].map(csvCell).join(',');
  const lines = hits.map((h) =>
    [h.index, h.id, ...cols.map((c) => displayValue(getPath(sourceOf(h), c)))]
      .map((v) => csvCell(v))
      .join(','),
  );
  return [header, ...lines].join('\n');
}

export function hitsToJson(hits: OsHit[]): string {
  return JSON.stringify(
    hits.map((h) => ({ _index: h.index, _id: h.id, _score: h.score, _source: h.source })),
    null,
    2,
  );
}

// ───────────── Sidebar grouping (O24) ─────────────

export interface IndexGroup {
  /** Group label, e.g. `logs-*` or a data stream name. */
  name: string;
  members: string[];
}

/** `logs-2026.09.01` → `logs-`; `.ds-metrics-000003` → data stream `metrics`. */
export function rollingPrefix(index: string): string | null {
  const ds = /^\.ds-(.+)-\d{6}$/.exec(index);
  if (ds) return `${ds[1]} (data stream)`;
  const dated = /^(.*?[-_.])\d{4}[.\-_]\d{2}(?:[.\-_]\d{2})?(?:[.\-_]\d{2})?$/.exec(index);
  if (dated) return `${dated[1]}*`;
  const rollover = /^(.*?-)\d{6}$/.exec(index);
  if (rollover) return `${rollover[1]}*`;
  return null;
}

/**
 * Group rolling indices (date-suffixed, rollover counters, data-stream
 * backing indices) under one row when at least `min` share a prefix.
 */
export function groupIndices(names: string[], min = 3): Array<string | IndexGroup> {
  const buckets = new Map<string, string[]>();
  for (const n of names) {
    const p = rollingPrefix(n);
    if (!p) continue;
    const list = buckets.get(p) ?? [];
    list.push(n);
    buckets.set(p, list);
  }
  const grouped = new Set<string>();
  const groups = new Map<string, IndexGroup>();
  for (const [p, members] of buckets) {
    if (members.length >= min) {
      groups.set(p, { name: p, members: [...members].sort() });
      for (const m of members) grouped.add(m);
    }
  }
  const out: Array<string | IndexGroup> = [];
  const emitted = new Set<string>();
  for (const n of names) {
    if (!grouped.has(n)) {
      out.push(n);
      continue;
    }
    const p = rollingPrefix(n) as string;
    if (!emitted.has(p)) {
      emitted.add(p);
      out.push(groups.get(p) as IndexGroup);
    }
  }
  return out;
}
