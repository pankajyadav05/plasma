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
 * `_explain/<id>` and `_termvectors/<id>` carry a trailing doc id; both
 * read. Checked separately because the suffix isn't fixed.
 */
function isIdScopedRead(segs: string[]): boolean {
  const n = segs.length;
  if (n >= 2 && (segs[n - 2] === '_explain' || segs[n - 2] === '_termvectors')) return true;
  if (n >= 1 && (segs[n - 1] === '_explain' || segs[n - 1] === '_termvectors')) return true;
  return false;
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
    if (READ_POST_SUFFIXES.some((s) => endsWith(segs, s))) return true;
    if (isIdScopedRead(segs)) return true;
    return false;
  }
  if (m === 'DELETE') {
    return READ_DELETE_SUFFIXES.some((s) => endsWith(segs, s));
  }
  return false;
}

export const OS_READ_ONLY_MESSAGE = 'this connection is read-only — writes are blocked';
