/**
 * Pure helpers for the OpenSearch driver (U22).
 *
 * Kept free of the client so unit tests can pin:
 * - SQL plugin fallback only on missing-endpoint (404)
 * - collision-free, request-local aggregation IDs for fieldStats
 */

import type { OsFieldStats, OsMappingNode } from '@shared/protocol';

/**
 * True when the OpenSearch/ES client error reports HTTP 404 — the only
 * case where falling back from `/_plugins/_sql` to legacy `/_sql` is
 * appropriate. Auth failures, bad SQL, timeouts, etc. must surface as-is.
 */
export function isMissingSqlEndpointError(err: unknown): boolean {
  const status = readHttpStatus(err);
  return status === 404;
}

function readHttpStatus(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as {
    statusCode?: unknown;
    meta?: { statusCode?: unknown; body?: { status?: unknown } };
  };
  // Prefer the client's statusCode getter when present (ResponseError prefers
  // meta.body.status, then meta.statusCode).
  if (typeof e.statusCode === 'number') return e.statusCode;
  // Mirror that preference for plain meta shapes used in tests/mocks.
  if (e.meta?.body && typeof e.meta.body.status === 'number') return e.meta.body.status;
  if (e.meta && typeof e.meta.statusCode === 'number') return e.meta.statusCode;
  return null;
}

/**
 * Build cardinality + terms aggregations keyed by request-local IDs
 * (`card_0`, `top_0`, …). Index-based IDs never collide across fields
 * like `user.id` vs `user_id` (which lossy sanitization would merge).
 */
export function buildFieldStatsAggs(fields: string[]): Record<string, unknown> {
  const aggs: Record<string, unknown> = {};
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    aggs[`card_${i}`] = { cardinality: { field } };
    aggs[`top_${i}`] = { terms: { field, size: 10 } };
  }
  return aggs;
}

/** Aggregation alias for the cardinality bucket of field `fields[i]`. */
export function fieldStatsCardKey(index: number): string {
  return `card_${index}`;
}

/** Aggregation alias for the terms bucket of field `fields[i]`. */
export function fieldStatsTopKey(index: number): string {
  return `top_${index}`;
}

/**
 * Map one field's aggregation reply into OsFieldStats using the same
 * request-local index that `buildFieldStatsAggs` used.
 */
export function readFieldStat(
  field: string,
  index: number,
  aggData: Record<string, unknown>,
  type: string | null,
): OsFieldStats {
  const card = aggData[fieldStatsCardKey(index)] as { value?: number } | undefined;
  const top = aggData[fieldStatsTopKey(index)] as
    | { buckets?: Array<{ key: unknown; doc_count: number }> }
    | undefined;
  return {
    field,
    type,
    cardinality: card && typeof card.value === 'number' ? Math.round(card.value) : null,
    topValues: (top?.buckets ?? []).map((b) => ({
      value: String(b.key),
      count: b.doc_count,
    })),
    isTime: type === 'date' || type === 'date_nanos',
  };
}

// ───────────── Mapping (O5) ─────────────

interface RawProp {
  type?: string;
  properties?: Record<string, unknown>;
  fields?: Record<string, { type?: string } | undefined>;
}

/** One mapped path, flattened: `user.id`, plus its multi-fields. */
export interface FlatMappingField {
  path: string;
  type: string | null;
  multiFields: Array<{ name: string; type: string | null }>;
}

/** Flatten `properties` to dotted paths (objects included, typed `object`/`nested`). */
export function flattenMappingProps(
  props: Record<string, unknown>,
  prefix = '',
  out: Record<string, FlatMappingField> = {},
): Record<string, FlatMappingField> {
  for (const [name, raw] of Object.entries(props)) {
    if (!raw || typeof raw !== 'object') continue;
    const node = raw as RawProp;
    const path = prefix ? `${prefix}.${name}` : name;
    const type = node.type ?? (node.properties ? 'object' : null);
    out[path] = {
      path,
      type,
      multiFields: Object.entries(node.fields ?? {}).map(([n, f]) => ({
        name: n,
        type: f?.type ?? null,
      })),
    };
    if (node.properties) flattenMappingProps(node.properties, path, out);
  }
  return out;
}

/**
 * Merge the `properties` of every matched index into one tree. When two
 * indices map the same path to different types, the node keeps the first
 * type and lists every type in `conflicts` instead of silently hiding it.
 */
export function mergeMappingTrees(perIndex: Array<Record<string, unknown>>): OsMappingNode[] {
  const roots: OsMappingNode[] = [];
  const merge = (into: OsMappingNode[], props: Record<string, unknown>) => {
    for (const [name, raw] of Object.entries(props)) {
      if (!raw || typeof raw !== 'object') continue;
      const node = raw as RawProp;
      const type = node.type ?? (node.properties ? 'object' : null);
      let target = into.find((n) => n.name === name);
      if (!target) {
        target = { name, type, children: [] };
        into.push(target);
      } else if (type !== target.type) {
        const seen = new Set(target.conflicts ?? [target.type ?? 'unknown']);
        seen.add(type ?? 'unknown');
        target.conflicts = [...seen];
      }
      const multi = Object.entries(node.fields ?? {}).map(([n, f]) => ({
        name: n,
        type: f?.type ?? null,
      }));
      if (multi.length > 0) {
        const existing = target.multiFields ?? [];
        for (const m of multi) if (!existing.some((e) => e.name === m.name)) existing.push(m);
        target.multiFields = existing;
      }
      if (node.properties) merge(target.children, node.properties);
    }
  };
  for (const props of perIndex) merge(roots, props);
  return roots;
}

// ───────────── Field stats (O2) ─────────────

const NOT_AGGREGATABLE = new Set([
  'object',
  'nested',
  'geo_point',
  'geo_shape',
  'xy_point',
  'xy_shape',
  'binary',
  'knn_vector',
  'flat_object',
  'join',
  'percolator',
  'rank_feature',
  'rank_features',
  'completion',
  'search_as_you_type',
  'match_only_text',
]);

/**
 * Pick the path to aggregate for `path`: itself when doc_values-backed,
 * the keyword multi-field for `text`, or null with a reason when the
 * type can't be aggregated at all.
 */
export function resolveAggField(
  path: string,
  flat: Record<string, FlatMappingField>,
): { field: string | null; type: string | null; reason: string | null } {
  const entry = flat[path];
  if (!entry) return { field: path, type: null, reason: null };
  const type = entry.type;
  if (type === 'text') {
    const kw = entry.multiFields.find((m) => m.type === 'keyword');
    return kw
      ? { field: `${path}.${kw.name}`, type, reason: null }
      : { field: null, type, reason: 'text field without a keyword sub-field' };
  }
  if (type && NOT_AGGREGATABLE.has(type)) {
    return { field: null, type, reason: `${type} fields can't be aggregated` };
  }
  return { field: path, type, reason: null };
}

/** Parse the optional DSL `query` object / query_string for field stats. */
export function statsQuery(query?: string, queryString?: string): Record<string, unknown> | null {
  if (query?.trim()) {
    const parsed = JSON.parse(query) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error('query must be a JSON object');
  }
  if (queryString?.trim()) return { query_string: { query: queryString } };
  return null;
}

/** Map one `_msearch` sub-response into OsFieldStats. */
export function readMsearchFieldStat(
  field: string,
  type: string | null,
  aggField: string,
  response: unknown,
): OsFieldStats {
  const r = (response ?? {}) as {
    error?: { reason?: string; root_cause?: Array<{ reason?: string }> } | string;
    aggregations?: Record<string, unknown>;
  };
  if (r.error) {
    const reason =
      typeof r.error === 'string'
        ? r.error
        : (r.error.root_cause?.[0]?.reason ?? r.error.reason ?? 'aggregation failed');
    return {
      field,
      type,
      cardinality: null,
      topValues: [],
      isTime: type === 'date' || type === 'date_nanos',
      aggField,
      error: reason,
    };
  }
  const stat = readFieldStat(field, 0, r.aggregations ?? {}, type);
  return { ...stat, aggField: aggField === field ? null : aggField, error: null };
}

// ───────────── Search results (O3) ─────────────

/** `hits.total` → value + relation (`gte` past the track_total_hits cap). */
export function parseTotal(raw: unknown): { total: number; relation: 'eq' | 'gte' } {
  if (typeof raw === 'number') return { total: raw, relation: 'eq' };
  if (raw && typeof raw === 'object') {
    const t = raw as { value?: unknown; relation?: unknown };
    return {
      total: typeof t.value === 'number' ? t.value : 0,
      relation: t.relation === 'gte' ? 'gte' : 'eq',
    };
  }
  return { total: 0, relation: 'eq' };
}

/** Parse a user DSL body; default to match_all. Applies size + track_total_hits defaults. */
export function prepareSearchBody(bodyText: string, size: number): Record<string, unknown> {
  const trimmed = bodyText.trim();
  let body: Record<string, unknown>;
  if (!trimmed) {
    body = { query: { match_all: {} } };
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(
        `invalid query DSL JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid query DSL JSON: the body must be an object');
    }
    body = parsed as Record<string, unknown>;
  }
  if (body.size === undefined) body.size = size;
  if (body.track_total_hits === undefined) body.track_total_hits = true;
  return body;
}

/** Encode an index expression for a URL path, keeping `*` and `,` usable. */
export function encodeIndexPath(index: string): string {
  return index
    .split(',')
    .map((part) => encodeURIComponent(part.trim()).replace(/%2A/gi, '*'))
    .join(',');
}

/** Normalise a console path to start with `/`. */
export function normalisePath(path: string): string {
  const p = path.trim();
  return p.startsWith('/') ? p : `/${p}`;
}

/** Endpoints whose body is NDJSON rather than one JSON object. */
export function isNdjsonPath(path: string): boolean {
  const noQuery = path.split('?')[0] ?? '';
  return /(^|\/)(_bulk|_msearch|_msearch\/template)\/?$/.test(noQuery);
}

/** Pull status + body out of a client ResponseError (4xx/5xx), or null for transport errors. */
export function responseFromError(err: unknown): { status: number; body: unknown } | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { meta?: { statusCode?: unknown; body?: unknown } };
  if (e.meta && typeof e.meta.statusCode === 'number' && e.meta.statusCode > 0) {
    return { status: e.meta.statusCode, body: e.meta.body ?? null };
  }
  return null;
}

/** Connection-level options for the OpenSearch client (O12). */
export interface OsConnectionPlan {
  /** Every node URL, main endpoint first. */
  nodes: string[];
  /** Basic auth, when that is the chosen mode. */
  basic?: { username: string; password: string };
  /** Extra request headers (API key). */
  headers: Record<string, string>;
  /** AWS SigV4 settings, when that is the chosen mode. */
  sigv4?: {
    region: string;
    service: 'es' | 'aoss';
    credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  };
}

/** `/search/` → `/search`; blank → ''. */
export function normalisePathPrefix(prefix: string | undefined): string {
  const t = (prefix ?? '').trim().replace(/\/+$/, '');
  if (!t) return '';
  return t.startsWith('/') ? t : `/${t}`;
}

/** An `id:key` API key becomes its base64 form; an already-encoded one passes through. */
export function apiKeyHeaderValue(key: string): string {
  const k = key.trim();
  if (k.includes(':')) return Buffer.from(k, 'utf8').toString('base64');
  return k;
}

export function planOpenSearchConnection(config: {
  host: string;
  port: number;
  ssl: boolean;
  user?: string;
  password?: string;
  opensearch?: {
    auth?: 'basic' | 'apiKey' | 'sigv4';
    apiKey?: string;
    awsRegion?: string;
    awsService?: 'es' | 'aoss';
    awsAccessKeyId?: string;
    awsSecretAccessKey?: string;
    awsSessionToken?: string;
    pathPrefix?: string;
    nodes?: string[];
  };
}): OsConnectionPlan {
  const o = config.opensearch ?? {};
  const protocol = config.ssl ? 'https' : 'http';
  const prefix = normalisePathPrefix(o.pathPrefix);
  const withPrefix = (url: string): string => {
    const u = new URL(url);
    if (prefix && (u.pathname === '/' || u.pathname === '')) u.pathname = prefix;
    return u.toString().replace(/\/$/, '');
  };
  const nodes = [withPrefix(`${protocol}://${config.host}:${config.port}`)];
  for (const raw of o.nodes ?? []) {
    const t = raw.trim();
    if (!t) continue;
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `${protocol}://${t}`;
    let node: string;
    try {
      node = withPrefix(url);
    } catch {
      throw new Error(`"${t}" is not a valid node URL`);
    }
    if (!nodes.includes(node)) nodes.push(node);
  }

  const auth = o.auth ?? 'basic';
  const plan: OsConnectionPlan = { nodes, headers: {} };
  if (auth === 'apiKey') {
    if (!o.apiKey?.trim()) throw new Error('An API key is required for API key authentication');
    plan.headers.Authorization = `ApiKey ${apiKeyHeaderValue(o.apiKey)}`;
  } else if (auth === 'sigv4') {
    if (!o.awsRegion?.trim()) throw new Error('An AWS region is required for SigV4 authentication');
    if (!o.awsAccessKeyId?.trim() || !o.awsSecretAccessKey) {
      throw new Error('AWS access key id and secret access key are required for SigV4');
    }
    plan.sigv4 = {
      region: o.awsRegion.trim(),
      service: o.awsService ?? 'es',
      credentials: {
        accessKeyId: o.awsAccessKeyId.trim(),
        secretAccessKey: o.awsSecretAccessKey,
        ...(o.awsSessionToken ? { sessionToken: o.awsSessionToken } : {}),
      },
    };
  } else if (config.user || config.password) {
    plan.basic = { username: config.user || '', password: config.password || '' };
  }
  return plan;
}
