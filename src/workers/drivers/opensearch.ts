import { Client } from '@opensearch-project/opensearch';
import type {
  ConnectionConfig,
  OsAlias,
  OsFieldStats,
  OsHit,
  OsIlmPolicy,
  OsMappingNode,
  OsOverview,
  OsSearchResult,
  OsSqlResult,
} from '@shared/protocol';

/**
 * OpenSearch driver — wraps the official @opensearch-project/opensearch
 * client. ConnectionConfig.ssl drives the http/https scheme; user +
 * password (when set) drive HTTP basic auth.
 *
 * The same client also speaks Elasticsearch 7.x — most read APIs match.
 * Things that differ (composable index templates, distribution-only
 * fields) we surface best-effort.
 */
export class OpenSearchDriver {
  private client: Client | null = null;
  private cachedVersion = 'unknown';

  async connect(config: ConnectionConfig): Promise<string> {
    await this.disconnect();
    const protocol = config.ssl ? 'https' : 'http';
    const auth =
      config.user || config.password
        ? { username: config.user || '', password: config.password || '' }
        : undefined;
    const node = `${protocol}://${config.host}:${config.port}`;
    const client = new Client({
      node,
      auth,
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
      requestTimeout: 10_000,
    });
    // Validate the connection eagerly with a /_info request.
    const info = (await client.info()).body as {
      cluster_name?: string;
      version?: { distribution?: string; number?: string };
    };
    this.client = client;
    this.cachedVersion = info.version?.number ?? 'unknown';
    return this.cachedVersion;
  }

  async disconnect(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (c) {
      try {
        await c.close();
      } catch {
        // best-effort
      }
    }
  }

  async overview(): Promise<OsOverview> {
    if (!this.client) throw new Error('not connected');
    const info = (await this.client.info()).body as {
      cluster_name?: string;
      version?: { distribution?: string; number?: string };
    };
    const health = (await this.client.cluster.health({})).body as {
      status?: string;
      number_of_nodes?: number;
    };

    // cat.indices returns one row per index with live counts/sizes.
    const cat = (
      await this.client.cat.indices({
        format: 'json',
        bytes: 'b',
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
      })
    ).body as unknown as Array<Record<string, string | null | undefined>>;

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
      .filter((i) => i.index && !i.index.startsWith('.security'));

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
    if (!this.client) throw new Error('not connected');
    const res = (await this.client.indices.getMapping({ index })).body as Record<
      string,
      { mappings?: { properties?: Record<string, unknown> } }
    >;
    // res is keyed by concrete index name (resolves wildcards). Merge
    // properties from all matched indices into one root.
    const merged: Record<string, unknown> = {};
    for (const entry of Object.values(res)) {
      const props = entry.mappings?.properties ?? {};
      Object.assign(merged, props);
    }
    return {
      name: index,
      type: null,
      children: buildMappingChildren(merged),
    };
  }

  async search(opts: {
    index: string;
    body: string;
    size: number;
  }): Promise<OsSearchResult> {
    if (!this.client) throw new Error('not connected');
    const trimmed = opts.body.trim();
    let body: Record<string, unknown>;
    if (!trimmed) {
      body = { query: { match_all: {} }, size: opts.size };
    } else {
      try {
        body = JSON.parse(trimmed) as Record<string, unknown>;
      } catch (err) {
        throw new Error(
          `invalid query DSL JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (body.size === undefined) body.size = opts.size;

    const start = Date.now();
    const res = (await this.client.search({ index: opts.index, body })).body as unknown as {
      took?: number;
      hits?: {
        total?: number | { value: number };
        hits?: Array<{ _id: string; _index: string; _score: number | null; _source: unknown }>;
      };
      aggregations?: unknown;
    };
    const took = res.took ?? Date.now() - start;
    const totalRaw = res.hits?.total;
    const total =
      typeof totalRaw === 'number'
        ? totalRaw
        : totalRaw && typeof totalRaw === 'object'
          ? (totalRaw.value ?? 0)
          : 0;

    const hits: OsHit[] = (res.hits?.hits ?? []).map((h) => ({
      index: h._index,
      id: h._id,
      score: typeof h._score === 'number' ? h._score : null,
      source: h._source,
    }));

    const fields = extractTopLevelFields(hits);

    return {
      total,
      took,
      hits,
      aggregations: res.aggregations ?? null,
      fields,
    };
  }

  /**
   * Run a query through the OpenSearch SQL plugin. Tries the OpenSearch
   * path first (`/_plugins/_sql`); on 404 falls back to the legacy ES
   * plugin endpoint (`/_sql`) so the same code works on both forks.
   *
   * Returns a tabular shape mirroring our QueryResult so the renderer
   * can reuse the existing grid plumbing.
   */
  async sql(query: string): Promise<OsSqlResult> {
    if (!this.client) throw new Error('not connected');
    const start = Date.now();
    const body = { query };
    let res;
    try {
      res = await this.client.transport.request({
        method: 'POST',
        path: '/_plugins/_sql',
        body,
      });
    } catch {
      res = await this.client.transport.request({
        method: 'POST',
        path: '/_sql',
        body,
      });
    }
    const payload = res.body as unknown as {
      schema?: Array<{ name: string; type: string }>;
      datarows?: unknown[][];
      total?: number;
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
    return {
      columns,
      rows,
      total,
      durationMs: Date.now() - start,
    };
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
    if (!this.client) throw new Error('not connected');
    const res = (await this.client.indices.create({ index: name, body })).body as {
      acknowledged?: boolean;
      index?: string;
    };
    return {
      acknowledged: res.acknowledged === true,
      index: res.index ?? name,
    };
  }

  async deleteIndex(name: string): Promise<{ acknowledged: boolean }> {
    if (!this.client) throw new Error('not connected');
    const res = (await this.client.indices.delete({ index: name })).body as {
      acknowledged?: boolean;
    };
    return { acknowledged: res.acknowledged === true };
  }

  async aliases(): Promise<OsAlias[]> {
    if (!this.client) throw new Error('not connected');
    const cat = (
      await this.client.cat.aliases({
        format: 'json',
        h: ['alias', 'index', 'filter', 'is_write_index'],
      })
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
    if (!this.client) throw new Error('not connected');
    // OpenSearch ISM path
    try {
      const res = await this.client.transport.request({
        method: 'GET',
        path: '/_plugins/_ism/policies',
      });
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
      const res = await this.client.transport.request({
        method: 'GET',
        path: '/_ilm/policy',
      });
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
   * Per-field stats used by the Discover canvas. One terms agg + one
   * cardinality agg per requested field, all in a single search call so
   * we round-trip once regardless of field count.
   */
  async fieldStats(opts: {
    index: string;
    fields: string[];
    queryString?: string;
  }): Promise<OsFieldStats[]> {
    if (!this.client) throw new Error('not connected');

    // Pull the mapping so we can label types + spot date fields.
    const mappingRes = (await this.client.indices.getMapping({ index: opts.index })).body as Record<
      string,
      { mappings?: { properties?: Record<string, { type?: string }> } }
    >;
    const props: Record<string, { type?: string }> = {};
    for (const v of Object.values(mappingRes)) {
      Object.assign(props, v.mappings?.properties ?? {});
    }

    const aggs: Record<string, unknown> = {};
    for (const f of opts.fields) {
      aggs[`card_${safeKey(f)}`] = { cardinality: { field: f } };
      aggs[`top_${safeKey(f)}`] = { terms: { field: f, size: 10 } };
    }

    const body: Record<string, unknown> = {
      size: 0,
      aggs,
    };
    if (opts.queryString) {
      body.query = { query_string: { query: opts.queryString } };
    }

    let raw: { aggregations?: Record<string, unknown> } = {};
    try {
      raw = (await this.client.search({ index: opts.index, body })).body as unknown as {
        aggregations?: Record<string, unknown>;
      };
    } catch (err) {
      // If a single bad field tanks the whole agg, surface zeros
      // instead of throwing — the Discover sidebar can still render.
      console.error('[plasma-os] fieldStats failed', err);
    }

    const aggData = raw.aggregations ?? {};
    return opts.fields.map((f) => {
      const cardKey = `card_${safeKey(f)}`;
      const topKey = `top_${safeKey(f)}`;
      const card = aggData[cardKey] as { value?: number } | undefined;
      const top = aggData[topKey] as
        | { buckets?: Array<{ key: unknown; doc_count: number }> }
        | undefined;
      const type = props[f]?.type ?? null;
      return {
        field: f,
        type,
        cardinality: card && typeof card.value === 'number' ? Math.round(card.value) : null,
        topValues: (top?.buckets ?? []).map((b) => ({
          value: String(b.key),
          count: b.doc_count,
        })),
        isTime: type === 'date' || type === 'date_nanos',
      };
    });
  }
}

/**
 * Sanitize a field name into something safe for an aggregation alias —
 * dots and special chars in field paths break agg key references.
 */
function safeKey(field: string): string {
  return field.replace(/[^a-zA-Z0-9]/g, '_');
}

function buildMappingChildren(props: Record<string, unknown>): OsMappingNode[] {
  const out: OsMappingNode[] = [];
  for (const [name, raw] of Object.entries(props)) {
    if (!raw || typeof raw !== 'object') continue;
    const node = raw as { type?: string; properties?: Record<string, unknown> };
    out.push({
      name,
      type: node.type ?? (node.properties ? 'object' : null),
      children: node.properties ? buildMappingChildren(node.properties) : [],
    });
  }
  return out;
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
