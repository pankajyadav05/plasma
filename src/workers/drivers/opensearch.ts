import { Client, errors as osErrors } from '@opensearch-project/opensearch';
import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws';
import { parseJsonKeepingBigInts } from '@shared/json-bigint';
import { OS_READ_ONLY_MESSAGE, isOsReadRequest, isReadOnlyOsSql } from '@shared/os-write-policy';
import type {
  ConnectionConfig,
  OsAlias,
  OsFieldStats,
  OsHit,
  OsIlmPolicy,
  OsMappingNode,
  OsOverview,
  OsRawResponse,
  OsSearchResult,
  OsSqlResult,
} from '@shared/protocol';
import { buildNodeTlsOptions, insecureTlsWarning, resolveTls } from '@shared/tls';
import {
  encodeIndexPath,
  flattenMappingProps,
  isMissingSqlEndpointError,
  isNdjsonPath,
  mergeMappingTrees,
  normalisePath,
  parseTotal,
  planOpenSearchConnection,
  prepareSearchBody,
  readMsearchFieldStat,
  resolveAggField,
  responseFromError,
  statsQuery,
} from './opensearch-helpers';

/** Default per-request timeout when neither the request nor settings set one (O6). */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * P2-14: the client buffers whole responses (a Dev Tools `_search?size=10000`
 * or `_cat` on a big cluster can be hundreds of MB). Responses are read as a
 * stream and abandoned past this many bytes.
 */
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/** SQL cursors kept open at once; the oldest is closed when exceeded. */
const MAX_OPEN_SQL_CURSORS = 16;

export class ResponseTooLargeError extends Error {
  override readonly name = 'ResponseTooLargeError';
  constructor(limit: number) {
    super(
      `The response is larger than ${Math.round(limit / (1024 * 1024))} MB and was dropped. Narrow the request: use filter_path, a smaller size, or a more specific index.`,
    );
  }
}

/** Read a response stream into text, giving up (and destroying it) past `limit` bytes. */
export async function readCappedText(
  body: AsyncIterable<Buffer | string> & { destroy?: () => void },
  limit: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    total += buf.byteLength;
    if (total > limit) {
      body.destroy?.();
      throw new ResponseTooLargeError(limit);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

type Abortable<T> = Promise<T> & { abort?: () => void };

interface TransportParams {
  method: string;
  path: string;
  body?: unknown;
  bulkBody?: string;
  querystring?: Record<string, unknown>;
}

/**
 * OpenSearch driver — wraps the official @opensearch-project/opensearch
 * client. ConnectionConfig.ssl drives the http/https scheme; user +
 * password (when set) drive HTTP basic auth.
 *
 * The same client also speaks Elasticsearch 7.x — most read APIs match.
 * Things that differ (composable index templates, distribution-only
 * fields) we surface best-effort.
 *
 * Write safety (S1/O1): a read-only connection refuses every mutating
 * call here too, independent of main's guard.
 */
export class OpenSearchDriver {
  private client: Client | null = null;
  private cachedVersion = 'unknown';
  private readOnly = false;
  private defaultTimeoutMs = DEFAULT_TIMEOUT_MS;
  /** In-flight abortable requests keyed by the renderer's request id (O6). */
  private inflight = new Map<string, () => void>();
  private autoRequestSeq = 0;
  /** SQL cursors the server still holds for us, oldest first (P2-14). */
  private openSqlCursors = new Set<string>();
  private readonly maxResponseBytes: number;

  constructor(opts: { maxResponseBytes?: number } = {}) {
    this.maxResponseBytes = opts.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  }

  /** SQL cursors the server may still hold for us (tests, diagnostics). */
  openSqlCursorCount(): number {
    return this.openSqlCursors.size;
  }

  async connect(config: ConnectionConfig, timeoutMs?: number): Promise<string> {
    await this.disconnect();
    const plan = planOpenSearchConnection(config);
    const ssl = buildNodeTlsOptions(config);
    if (resolveTls(config)?.mode === 'insecure') {
      console.warn(insecureTlsWarning(config.host));
    }
    this.defaultTimeoutMs = timeoutMs && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    const signer = plan.sigv4
      ? AwsSigv4Signer({
          region: plan.sigv4.region,
          service: plan.sigv4.service,
          getCredentials: async () => plan.sigv4!.credentials,
        })
      : null;
    const client = new Client({
      ...(signer ?? {}),
      ...(plan.nodes.length === 1 ? { node: plan.nodes[0] } : { nodes: plan.nodes }),
      ...(plan.basic ? { auth: plan.basic } : {}),
      ...(Object.keys(plan.headers).length > 0 ? { headers: plan.headers } : {}),
      ssl,
      requestTimeout: this.defaultTimeoutMs,
    });
    // Validate the connection eagerly with a /_info request (short timeout).
    const info = (await client.info({}, { requestTimeout: 10_000 })).body as {
      cluster_name?: string;
      version?: { distribution?: string; number?: string };
    };
    // Any HTTP server answers GET /; only OpenSearch and Elasticsearch say which version they are.
    if (!info || typeof info !== 'object' || !info.version?.number) {
      await client.close().catch(() => undefined);
      throw new Error('The server answered, but it is not OpenSearch (no version in its reply)');
    }
    this.client = client;
    this.readOnly = config.readOnly === true;
    this.cachedVersion = info.version.number;
    return this.cachedVersion;
  }

  /** Cluster health colour (`green`, `yellow`, `red`), or null when the cluster did not say. */
  async clusterStatus(): Promise<string | null> {
    const res = await this.transport(
      { method: 'GET', path: '/_cluster/health', querystring: { filter_path: 'status' } },
      { timeoutMs: 5_000 },
    );
    const status = (res.body as { status?: unknown } | null)?.status;
    return typeof status === 'string' ? status : null;
  }

  async disconnect(): Promise<void> {
    for (const abort of this.inflight.values()) abort();
    this.inflight.clear();
    const c = this.client;
    // Free the server-side SQL cursors while we can still talk to it.
    if (c && this.openSqlCursors.size > 0) {
      await Promise.allSettled([...this.openSqlCursors].map((cur) => this.closeCursorWith(c, cur)));
    }
    this.openSqlCursors.clear();
    this.client = null;
    this.readOnly = false;
    if (c) {
      try {
        await c.close();
      } catch {
        // best-effort
      }
    }
  }

  private requireClient(): Client {
    if (!this.client) throw new Error('not connected');
    return this.client;
  }

  private assertWritable(): void {
    if (this.readOnly) throw new Error(OS_READ_ONLY_MESSAGE);
  }

  /**
   * Run a transport request that `cancel(requestId)` can abort. Aborts
   * surface as "request cancelled"; the timeout is per request.
   */
  private async transport(
    params: TransportParams,
    opts: { timeoutMs?: number; requestId?: string } = {},
  ): Promise<{ statusCode: number; body: unknown }> {
    const client = this.requireClient();
    const requestTimeout = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : undefined;
    const promise = client.transport.request(
      params as unknown as Parameters<Client['transport']['request']>[0],
      {
        ...(requestTimeout ? { requestTimeout } : {}),
        maxRetries: 0,
        // Read the body ourselves so it can be size-capped (P2-14).
        asStream: true,
        ...(opts.requestId ? { opaqueId: `plasma-${opts.requestId}` } : {}),
      },
    ) as unknown as Abortable<{
      statusCode: number | null;
      headers?: Record<string, string | string[] | undefined>;
      body: AsyncIterable<Buffer | string> & { destroy?: () => void };
    }>;
    let aborted = false;
    let bodyStream: { destroy?: () => void } | null = null;
    // Every request is abortable: without a renderer id, `disconnect()` still reaches it.
    const key = opts.requestId ?? `auto-${++this.autoRequestSeq}`;
    this.inflight.set(key, () => {
      aborted = true;
      promise.abort?.();
      bodyStream?.destroy?.();
    });
    try {
      const res = await promise;
      bodyStream = res.body;
      const statusCode = res.statusCode ?? 200;
      const text = await readCappedText(res.body, this.maxResponseBytes);
      const contentType = String(res.headers?.['content-type'] ?? '');
      let body: unknown = text;
      if (params.method === 'HEAD') {
        body = statusCode < 400;
      } else if (/json/.test(contentType) && text !== '') {
        // A number beyond 2^53 would lose digits in a JS number; those come back as exact text.
        body = parseJsonKeepingBigInts(text);
      }
      if (statusCode >= 400 && !(params.method === 'HEAD' && statusCode === 404)) {
        throw new osErrors.ResponseError({
          statusCode,
          body,
          headers: res.headers ?? {},
          meta: {},
        } as unknown as ConstructorParameters<typeof osErrors.ResponseError>[0]);
      }
      return { statusCode, body };
    } catch (err) {
      if (aborted) throw new Error('request cancelled');
      const name = err && typeof err === 'object' ? (err as { name?: string }).name : undefined;
      if (name === 'TimeoutError') {
        throw new Error(
          `request timed out after ${Math.round((requestTimeout ?? this.defaultTimeoutMs) / 1000)} s`,
        );
      }
      throw err;
    } finally {
      this.inflight.delete(key);
    }
  }

  /**
   * Run a typed client call (overview, mapping, aliases…) so `cancel()` and
   * `disconnect()` can abort it too; without this only search / SQL / REST
   * requests were abortable (P2-14).
   */
  private async tracked<T>(p: Abortable<T>, requestId?: string): Promise<T> {
    const key = requestId ?? `auto-${++this.autoRequestSeq}`;
    let aborted = false;
    this.inflight.set(key, () => {
      aborted = true;
      p.abort?.();
    });
    try {
      return await p;
    } catch (err) {
      if (aborted) throw new Error('request cancelled');
      throw err;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async closeCursorWith(client: Client, cursor: string): Promise<void> {
    await client.transport
      .request(
        { method: 'POST', path: '/_plugins/_sql/close', body: { cursor } },
        { requestTimeout: 5_000, maxRetries: 0 },
      )
      .catch(() => undefined);
  }

  /** Release a server-side SQL cursor the user stopped paging through. */
  async closeSqlCursor(cursor: string): Promise<void> {
    if (!this.openSqlCursors.delete(cursor) || !this.client) return;
    await this.closeCursorWith(this.client, cursor);
  }

  private rememberSqlCursor(previous: string | undefined, next: string | null): void {
    if (previous) this.openSqlCursors.delete(previous);
    if (!next) return;
    this.openSqlCursors.delete(next);
    this.openSqlCursors.add(next);
    // Abandoned paging must not pile up on the cluster: close the oldest.
    while (this.openSqlCursors.size > MAX_OPEN_SQL_CURSORS) {
      const oldest = this.openSqlCursors.values().next().value as string | undefined;
      if (!oldest) break;
      void this.closeSqlCursor(oldest);
    }
  }

  /**
   * Abort an in-flight request (O6) and best-effort cancel the matching
   * server-side search task so it stops consuming the cluster.
   */
  async cancel(requestId: string): Promise<void> {
    const abort = this.inflight.get(requestId);
    this.inflight.delete(requestId);
    abort?.();
    const client = this.client;
    if (!client) return;
    try {
      const res = await client.transport.request(
        { method: 'GET', path: '/_tasks', querystring: { detailed: 'true', actions: '*search*' } },
        { requestTimeout: 5_000, maxRetries: 0 },
      );
      const body = res.body as {
        nodes?: Record<string, { tasks?: Record<string, { headers?: Record<string, string> }> }>;
      };
      const opaque = `plasma-${requestId}`;
      for (const nodeInfo of Object.values(body.nodes ?? {})) {
        for (const [taskId, task] of Object.entries(nodeInfo.tasks ?? {})) {
          if (task.headers?.['X-Opaque-Id'] === opaque) {
            await client.transport
              .request(
                { method: 'POST', path: `/_tasks/${encodeURIComponent(taskId)}/_cancel` },
                { requestTimeout: 5_000, maxRetries: 0 },
              )
              .catch(() => undefined);
          }
        }
      }
    } catch {
      // Task lookup is best-effort; the client-side abort already happened.
    }
  }

  async overview(): Promise<OsOverview> {
    const client = this.requireClient();
    const info = (await this.tracked(client.info() as Abortable<{ body: unknown }>)).body as {
      cluster_name?: string;
      version?: { distribution?: string; number?: string };
    };
    const health = (await this.tracked(client.cluster.health({}) as Abortable<{ body: unknown }>))
      .body as {
      status?: string;
      number_of_nodes?: number;
    };

    // cat.indices returns one row per index with live counts/sizes.
    const cat = (
      await this.tracked(
        client.cat.indices({
          format: 'json',
          bytes: 'b',
          expand_wildcards: 'all',
          h: [
            'index',
            'health',
            'status',
            'uuid',
            'pri',
            'rep',
            'docs.count',
            'docs.deleted',
            'store.size',
          ],
        } as Parameters<Client['cat']['indices']>[0]) as Abortable<{ body: unknown }>,
      )
    ).body as unknown as Array<Record<string, string | null | undefined>>;

    // System indices (including `.security*`) are hidden in the UI, not
    // here, so "Show system indices" can reveal them (O10).
    const indices = cat
      .map((row) => ({
        index: row.index ?? '',
        health: row.health ?? '',
        status: row.status ?? '',
        uuid: row.uuid ?? null,
        primaries: Number(row.pri ?? 0) || 0,
        replicas: Number(row.rep ?? 0) || 0,
        docsCount: Number(row['docs.count'] ?? 0) || 0,
        docsDeleted: Number(row['docs.deleted'] ?? 0) || 0,
        storeBytes: Number(row['store.size'] ?? 0) || 0,
      }))
      .filter((i) => i.index);

    return {
      clusterName: info.cluster_name ?? 'unknown',
      distribution: info.version?.distribution ?? 'opensearch',
      version: info.version?.number ?? this.cachedVersion,
      health: health.status ?? 'unknown',
      nodes: health.number_of_nodes ?? 0,
      indices,
    };
  }

  async mapping(index: string): Promise<OsMappingNode> {
    const client = this.requireClient();
    const res = (
      await this.tracked(client.indices.getMapping({ index }) as Abortable<{ body: unknown }>)
    ).body as Record<string, { mappings?: { properties?: Record<string, unknown> } }>;
    // res is keyed by concrete index name (resolves wildcards/aliases).
    // Merge per path and flag conflicting types instead of hiding them (O5).
    const perIndex = Object.values(res).map((entry) => entry.mappings?.properties ?? {});
    return {
      name: index,
      type: null,
      children: mergeMappingTrees(perIndex),
    };
  }

  async search(opts: {
    index: string;
    body: string;
    size: number;
    timeoutMs?: number;
    requestId?: string;
  }): Promise<OsSearchResult> {
    const body = prepareSearchBody(opts.body, opts.size);
    const start = Date.now();
    const res = await this.transport(
      { method: 'POST', path: `/${encodeIndexPath(opts.index)}/_search`, body },
      { timeoutMs: opts.timeoutMs, requestId: opts.requestId },
    );
    const payload = res.body as {
      took?: number;
      hits?: {
        total?: unknown;
        hits?: Array<{
          _id: string;
          _index: string;
          _score: number | null;
          _source: unknown;
          sort?: unknown[];
        }>;
      };
      aggregations?: unknown;
    };
    const took = payload.took ?? Date.now() - start;
    const { total, relation } = parseTotal(payload.hits?.total);

    const hits: OsHit[] = (payload.hits?.hits ?? []).map((h) => ({
      index: h._index,
      id: h._id,
      score: typeof h._score === 'number' ? h._score : null,
      source: h._source,
      ...(Array.isArray(h.sort) ? { sort: h.sort } : {}),
    }));

    return {
      total,
      totalRelation: relation,
      took,
      hits,
      aggregations: payload.aggregations ?? null,
      fields: extractTopLevelFields(hits),
    };
  }

  /**
   * Run a query through the OpenSearch SQL plugin. Tries the OpenSearch
   * path first (`/_plugins/_sql`); on 404 falls back to the legacy ES
   * plugin endpoint (`/_sql`) so the same code works on both forks.
   *
   * `fetchSize` turns on cursor paging; pass the returned `cursor` back
   * (with an empty query) for the next page (O20).
   */
  async sql(opts: {
    query: string;
    fetchSize?: number;
    cursor?: string;
    timeoutMs?: number;
    requestId?: string;
  }): Promise<OsSqlResult> {
    const start = Date.now();
    let body: Record<string, unknown>;
    if (opts.cursor) {
      body = { cursor: opts.cursor };
    } else {
      if (!opts.query.trim()) throw new Error('query required');
      if (this.readOnly && !isReadOnlyOsSql(opts.query)) throw new Error(OS_READ_ONLY_MESSAGE);
      body = { query: opts.query };
      if (opts.fetchSize) body.fetch_size = opts.fetchSize;
    }
    const call = { timeoutMs: opts.timeoutMs, requestId: opts.requestId };
    let res: { body: unknown };
    try {
      res = await this.transport({ method: 'POST', path: '/_plugins/_sql', body }, call);
    } catch (err) {
      // Only the missing-plugin 404 should fall back to legacy `/_sql`.
      // Auth failures, invalid SQL, timeouts, etc. must keep their original error.
      if (!isMissingSqlEndpointError(err)) throw err;
      res = await this.transport({ method: 'POST', path: '/_sql', body }, call);
    }
    const payload = res.body as {
      schema?: Array<{ name: string; type: string }>;
      datarows?: unknown[][];
      total?: number;
      cursor?: string;
      // ES 7 SQL flavor uses these instead.
      columns?: Array<{ name: string; type: string }>;
      rows?: unknown[][];
    };
    const columns = (payload.schema ?? payload.columns ?? []).map((c) => ({
      name: c.name,
      type: c.type,
    }));
    const rows = (payload.datarows ?? payload.rows ?? []) as unknown[][];
    const total = typeof payload.total === 'number' ? payload.total : rows.length;
    const nextCursor = typeof payload.cursor === 'string' && payload.cursor ? payload.cursor : null;
    this.rememberSqlCursor(opts.cursor, nextCursor);
    return {
      columns,
      rows,
      total,
      durationMs: Date.now() - start,
      cursor: typeof payload.cursor === 'string' && payload.cursor ? payload.cursor : null,
    };
  }

  /**
   * Arbitrary REST call for the Dev Tools console, document CRUD and
   * index/cluster operations (O13–O17). HTTP error responses come back
   * as `{ status, body }` rather than throwing so the console can show
   * them; transport failures (timeout, refused, aborted) still throw.
   */
  async request(opts: {
    method: string;
    path: string;
    body?: string;
    timeoutMs?: number;
    requestId?: string;
  }): Promise<OsRawResponse> {
    const path = normalisePath(opts.path);
    const text = opts.body?.trim() ? opts.body : undefined;
    if (this.readOnly && !isOsReadRequest(opts.method, path, text)) {
      throw new Error(OS_READ_ONLY_MESSAGE);
    }
    const [pathOnly, qs] = splitQuery(path);
    const params: TransportParams = { method: opts.method.toUpperCase(), path: pathOnly };
    if (qs) params.querystring = qs;
    if (text !== undefined) {
      if (isNdjsonPath(pathOnly)) {
        params.bulkBody = text.endsWith('\n') ? text : `${text}\n`;
      } else {
        try {
          JSON.parse(text);
        } catch (err) {
          throw new Error(`invalid JSON body: ${err instanceof Error ? err.message : String(err)}`);
        }
        // Sent as typed: parsing and re-serialising would round a number beyond 2^53.
        params.body = text;
      }
    }
    const start = Date.now();
    try {
      const res = await this.transport(params, {
        timeoutMs: opts.timeoutMs,
        requestId: opts.requestId,
      });
      return { status: res.statusCode, body: res.body ?? null, durationMs: Date.now() - start };
    } catch (err) {
      const http = responseFromError(err);
      if (http) return { ...http, durationMs: Date.now() - start };
      throw err;
    }
  }

  /**
   * Create an index. `body` is the raw create-index request payload —
   * `{ settings, mappings, aliases }`. Returns the cluster's own
   * acknowledgement plus the resolved index name (which may differ from
   * the requested name in the case of a date-math expression).
   */
  async createIndex(
    name: string,
    body: Record<string, unknown> | undefined,
  ): Promise<{ acknowledged: boolean; index: string }> {
    const client = this.requireClient();
    this.assertWritable();
    const res = (await client.indices.create({ index: name, body })).body as {
      acknowledged?: boolean;
      index?: string;
    };
    return {
      acknowledged: res.acknowledged === true,
      index: res.index ?? name,
    };
  }

  async deleteIndex(name: string): Promise<{ acknowledged: boolean }> {
    const client = this.requireClient();
    this.assertWritable();
    const res = (await client.indices.delete({ index: name })).body as {
      acknowledged?: boolean;
    };
    return { acknowledged: res.acknowledged === true };
  }

  async aliases(): Promise<OsAlias[]> {
    const client = this.requireClient();
    const cat = (
      await this.tracked(
        client.cat.aliases({
          format: 'json',
          h: ['alias', 'index', 'filter', 'is_write_index'],
        }) as Abortable<{ body: unknown }>,
      )
    ).body as unknown as Array<Record<string, string | undefined>>;
    return cat.map((row) => ({
      alias: row.alias ?? '',
      index: row.index ?? '',
      filter: row.filter && row.filter !== '-' ? row.filter : null,
      isWriteIndex: row.is_write_index === 'true',
    }));
  }

  /**
   * Read ISM (OpenSearch) policies first; fall back to ES ILM. The two
   * shapes differ but we forward the raw policy doc — the renderer
   * walks it as a JSON tree.
   */
  async ilm(): Promise<OsIlmPolicy[]> {
    const client = this.requireClient();
    // OpenSearch ISM path
    try {
      const res = await this.tracked(
        client.transport.request({
          method: 'GET',
          path: '/_plugins/_ism/policies',
        }) as Abortable<{ body: unknown }>,
      );
      const body = res.body as unknown as {
        policies?: Array<{
          _id?: string;
          policy?: { policy_id?: string; last_updated_time?: number };
        }>;
      };
      const list = body.policies ?? [];
      return list.map((p) => ({
        name: p._id ?? p.policy?.policy_id ?? 'unknown',
        policy: p.policy ?? p,
        lastUpdated:
          typeof p.policy?.last_updated_time === 'number' ? p.policy.last_updated_time : null,
      }));
    } catch {
      // Fall through to ES ILM
    }
    try {
      const res = await this.tracked(
        client.transport.request({
          method: 'GET',
          path: '/_ilm/policy',
        }) as Abortable<{ body: unknown }>,
      );
      const body = res.body as unknown as Record<
        string,
        { policy: unknown; modified_date_string?: string; modified_date?: number }
      >;
      return Object.entries(body).map(([name, p]) => ({
        name,
        policy: p.policy,
        lastUpdated:
          typeof p.modified_date === 'number'
            ? p.modified_date
            : p.modified_date_string
              ? Date.parse(p.modified_date_string)
              : null,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Per-field stats used by the Discover canvas (O2). Each field is its
   * own `_msearch` sub-request, so one field that can't be aggregated
   * (text without keyword, geo_point, object…) no longer blanks every
   * other field. `text` fields aggregate their keyword multi-field.
   */
  async fieldStats(opts: {
    index: string;
    fields: string[];
    queryString?: string;
    query?: string;
    requestId?: string;
    timeoutMs?: number;
  }): Promise<OsFieldStats[]> {
    const client = this.requireClient();

    const mappingRes = (
      await this.tracked(
        client.indices.getMapping({ index: opts.index }) as Abortable<{ body: unknown }>,
        opts.requestId,
      )
    ).body as Record<string, { mappings?: { properties?: Record<string, unknown> } }>;
    const flat: ReturnType<typeof flattenMappingProps> = {};
    for (const v of Object.values(mappingRes)) {
      flattenMappingProps(v.mappings?.properties ?? {}, '', flat);
    }

    const query = statsQuery(opts.query, opts.queryString);
    const plans = opts.fields.map((f) => resolveAggField(f, flat));
    const runnable = plans.filter((p): p is typeof p & { field: string } => p.field !== null);

    let responses: unknown[] = [];
    if (runnable.length > 0) {
      const lines: string[] = [];
      for (const p of runnable) {
        lines.push(JSON.stringify({ index: opts.index }));
        lines.push(
          JSON.stringify({
            size: 0,
            track_total_hits: false,
            ...(query ? { query } : {}),
            aggs: {
              card_0: { cardinality: { field: p.field } },
              top_0: { terms: { field: p.field, size: 10 } },
            },
          }),
        );
      }
      const res = await this.transport(
        {
          method: 'POST',
          path: '/_msearch',
          bulkBody: `${lines.join('\n')}\n`,
        },
        { timeoutMs: opts.timeoutMs, requestId: opts.requestId },
      );
      responses = (res.body as { responses?: unknown[] }).responses ?? [];
    }

    let r = 0;
    return plans.map((p, i) => {
      const requested = opts.fields[i]!;
      if (p.field === null) {
        return {
          field: requested,
          type: p.type,
          cardinality: null,
          topValues: [],
          isTime: false,
          aggField: null,
          error: p.reason,
        };
      }
      const response = responses[r++];
      return readMsearchFieldStat(requested, p.type, p.field, response);
    });
  }
}

/** Split `/a/b?x=1&y` into the path and a querystring object. */
function splitQuery(path: string): [string, Record<string, string> | null] {
  const q = path.indexOf('?');
  if (q < 0) return [path, null];
  const params = new URLSearchParams(path.slice(q + 1));
  const out: Record<string, string> = {};
  for (const [k, v] of params) out[k] = v;
  return [path.slice(0, q), Object.keys(out).length > 0 ? out : null];
}

function extractTopLevelFields(hits: OsHit[]): string[] {
  const seen = new Set<string>();
  for (const h of hits) {
    if (h.source && typeof h.source === 'object' && !Array.isArray(h.source)) {
      for (const k of Object.keys(h.source as Record<string, unknown>)) seen.add(k);
    }
    if (seen.size > 64) break;
  }
  return [...seen].sort();
}
