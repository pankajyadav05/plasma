/**
 * OpenSearch write-safety policy (S1 / O1 / O14).
 *
 * Pure classification shared by main (IPC guard), the worker driver
 * (defence in depth) and the renderer (to disable write actions up front).
 * Anything we can't prove is a read counts as a write, so a read-only
 * connection can never mutate the cluster through the console, the SQL
 * plugin or a document/index action.
 */

export type OsHttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export const OS_HTTP_METHODS: readonly OsHttpMethod[] = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
];

/**
 * POST endpoints that only read. Matched against the path's trailing
 * segments, so `/logs-*\/_search` and `/_search` both match `_search`.
 */
const READ_POST_SUFFIXES: readonly string[][] = [
  ['_search'],
  ['_msearch'],
  ['_count'],
  ['_field_caps'],
  ['_mget'],
  ['_analyze'],
  ['_validate', 'query'],
  ['_search', 'scroll'],
  ['_search', 'template'],
  ['_msearch', 'template'],
  ['_render', 'template'],
  ['_mtermvectors'],
  ['_search', 'point_in_time'],
  ['_plugins', '_ppl'],
  ['_plugins', '_sql', '_explain'],
  ['_plugins', '_ppl', '_explain'],
  ['_sql', 'translate'],
  ['_cluster', 'allocation', 'explain'],
];

/** Endpoints whose body decides read vs write (the SQL plugin). */
const SQL_PATHS: readonly string[][] = [['_plugins', '_sql'], ['_sql'], ['_opendistro', '_sql']];

/** DELETE endpoints that only release server-side read contexts. */
const READ_DELETE_SUFFIXES: readonly string[][] = [
  ['_search', 'scroll'],
  ['_search', 'point_in_time'],
  ['_plugins', '_sql', 'close'],
];

/** Split `/a/b?x=1` into `['a', 'b']` (query string and empty parts dropped). */
export function osPathSegments(path: string): string[] {
  const noQuery = path.split('?')[0] ?? '';
  return noQuery
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
}

function endsWith(segs: string[], suffix: readonly string[]): boolean {
  if (segs.length < suffix.length) return false;
  const tail = segs.slice(segs.length - suffix.length);
  return tail.every((s, i) => s === suffix[i]);
}

/**
 * A segment that can name an index expression (`logs-*`, `a,b`, `_all`).
 * Real index names never start with `_`, which is what stops
 * `/idx/_doc/_search` (a document whose id is `_search`) from looking like
 * `/<index>/_search`. Percent-escapes and slashes are refused outright so
 * an encoded `_doc` cannot hide in the "index" slot.
 */
function isIndexExpression(seg: string): boolean {
  if (seg === '_all') return true;
  return /^[^_%/\\][^%/\\]*$/.test(seg);
}

/**
 * Suffixes that are cluster-level or plugin APIs: they only read when
 * nothing precedes them, so `/anything/_plugins/_ppl` is not trusted.
 */
function isAnchoredSuffix(suffix: readonly string[]): boolean {
  const first = suffix[0];
  return (
    first === '_plugins' ||
    first === '_cluster' ||
    first === '_render' ||
    first === '_sql' ||
    // `_search/scroll` and `_search/point_in_time` are cluster-level;
    // `_search/template` and `_msearch/template` may carry an index.
    (first === '_search' && (suffix[1] === 'scroll' || suffix[1] === 'point_in_time'))
  );
}

/**
 * True when `segs` ends with `suffix` and what precedes it is either
 * nothing or a single index expression. Anything else (`_doc`, `_create`,
 * `_update`, `_bulk`, extra segments) is a document/write API whose id or
 * sub-path merely looks like a read endpoint.
 */
function matchesReadEndpoint(segs: string[], suffix: readonly string[]): boolean {
  if (!endsWith(segs, suffix)) return false;
  const prefix = segs.slice(0, segs.length - suffix.length);
  if (prefix.length === 0) return true;
  if (isAnchoredSuffix(suffix)) return false;
  return prefix.length === 1 && isIndexExpression(prefix[0] ?? '');
}

/**
 * `/<index>/_explain/<id>` and `/<index>/_termvectors[/<id>]` read. The
 * keyword must sit directly after a single index expression, so
 * `/idx/_doc/_explain` (a document id) stays a write.
 */
function isIdScopedRead(segs: string[]): boolean {
  const [index, kw] = segs;
  if (segs.length < 2 || segs.length > 3) return false;
  if (!isIndexExpression(index ?? '')) return false;
  if (kw === '_explain') return segs.length === 3;
  return kw === '_termvectors';
}

/** Leading-comment / whitespace stripped first keyword of a SQL statement. */
function firstSqlKeyword(sql: string): string {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/^[\s(]+/, '');
  const m = /^([A-Za-z]+)/.exec(stripped);
  return m ? m[1]!.toUpperCase() : '';
}

/**
 * True when an OpenSearch SQL statement can only read. The SQL plugin
 * can run `DELETE` (and, on some versions, other DML) — only SELECT /
 * SHOW / DESCRIBE / EXPLAIN pass, and only as a single statement.
 */
export function isReadOnlyOsSql(sql: string): boolean {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (!trimmed) return false;
  // A second statement after `;` could be anything.
  if (/;\s*\S/.test(trimmed.replace(/'(?:[^'\\]|\\.)*'/g, "''"))) return false;
  const kw = firstSqlKeyword(trimmed);
  return kw === 'SELECT' || kw === 'SHOW' || kw === 'DESCRIBE' || kw === 'DESC' || kw === 'EXPLAIN';
}

function sqlBodyIsRead(body: unknown): boolean {
  let parsed: unknown = body;
  if (typeof body === 'string') {
    if (!body.trim()) return false;
    try {
      parsed = JSON.parse(body);
    } catch {
      return false;
    }
  }
  if (!parsed || typeof parsed !== 'object') return false;
  const b = parsed as { query?: unknown; cursor?: unknown };
  if (typeof b.query === 'string') return isReadOnlyOsSql(b.query);
  // Fetching the next page of an existing cursor only reads.
  return typeof b.cursor === 'string' && b.query === undefined;
}

/**
 * True when `method path [body]` can only read. Unknown combinations are
 * treated as writes.
 */
export function isOsReadRequest(method: string, path: string, body?: unknown): boolean {
  const m = method.toUpperCase();
  const segs = osPathSegments(path);
  if (m === 'GET' || m === 'HEAD') {
    // `GET /_plugins/_sql?...` isn't a thing, but guard SQL bodies anyway.
    if (SQL_PATHS.some((p) => segs.length === p.length && endsWith(segs, p))) {
      return body === undefined || body === '' || sqlBodyIsRead(body);
    }
    return true;
  }
  if (m === 'POST') {
    if (SQL_PATHS.some((p) => segs.length === p.length && endsWith(segs, p))) {
      return sqlBodyIsRead(body);
    }
    if (READ_POST_SUFFIXES.some((s) => matchesReadEndpoint(segs, s))) return true;
    if (isIdScopedRead(segs)) return true;
    return false;
  }
  if (m === 'DELETE') {
    // Only the cluster-level scroll / PIT / cursor releases read.
    return READ_DELETE_SUFFIXES.some((s) => segs.length === s.length && endsWith(segs, s));
  }
  return false;
}

export const OS_READ_ONLY_MESSAGE = 'this connection is read-only — writes are blocked';

/**
 * Create/delete index must name exactly one concrete index (SC-30). A
 * pattern, list or `_all` could drop many indices on clusters that don't
 * require explicit names for destructive actions.
 */
export function osSingleIndexNameError(name: string): string | null {
  if (!name || name.trim() !== name) return 'index name must be a single concrete name';
  if (/[*?,\s/\\%]/.test(name))
    return 'index name must be a single concrete name (no wildcards or lists)';
  if (
    name.startsWith('_') ||
    name.startsWith('-') ||
    name.startsWith('+') ||
    name === '.' ||
    name === '..'
  )
    return 'index name must not start with "_", "-" or "+"';
  if (name.toLowerCase() === 'all') return 'index name must be a single concrete name';
  return null;
}

export function assertOsSingleIndexName(name: string): void {
  const err = osSingleIndexNameError(name);
  if (err) throw new Error(err);
}
