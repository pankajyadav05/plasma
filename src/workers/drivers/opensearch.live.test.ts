/**
 * Live OpenSearch driver checks — opt-in: PLASMA_LIVE_OS=http://localhost:9200
 * (security disabled). Seeds and drops its own `plasma-live-*` indices.
 */
import type { ConnectionConfig } from '@shared/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenSearchDriver } from './opensearch';

const LIVE = process.env.PLASMA_LIVE_OS;
const IDX = 'plasma-live-events';

function config(readOnly = false): ConnectionConfig {
  const url = new URL(LIVE ?? 'http://localhost:9200');
  return {
    id: 'live-os',
    name: 'live',
    engine: 'opensearch',
    host: url.hostname,
    port: Number(url.port || 9200),
    database: '',
    user: '',
    password: '',
    ssl: url.protocol === 'https:',
    readOnly,
  } as ConnectionConfig;
}

describe.skipIf(!LIVE)('OpenSearchDriver (live)', () => {
  const os = new OpenSearchDriver();

  beforeAll(async () => {
    await os.connect(config());
    await os.request({ method: 'DELETE', path: `/${IDX}` });
    await os.request({
      method: 'PUT',
      path: `/${IDX}`,
      body: JSON.stringify({
        mappings: {
          properties: {
            title: { type: 'text' },
            name: { type: 'text', fields: { keyword: { type: 'keyword' } } },
            sev: { type: 'keyword' },
            loc: { type: 'geo_point' },
            user: { properties: { id: { type: 'keyword' } } },
          },
        },
      }),
    });
    let bulk = '';
    for (let i = 1; i <= 10_050; i++) {
      bulk += `${JSON.stringify({ index: { _index: IDX, _id: String(i) } })}\n`;
      bulk += `${JSON.stringify({ title: `t ${i}`, name: `n${i % 7}`, sev: ['a', 'b', 'c'][i % 3], loc: { lat: 1, lon: 2 }, user: { id: `u${i % 5}` } })}\n`;
    }
    const res = await os.request({ method: 'POST', path: '/_bulk?refresh=true', body: bulk });
    expect(res.status).toBe(200);
  }, 60_000);

  afterAll(async () => {
    await os.request({ method: 'DELETE', path: `/${IDX}` });
    await os.disconnect();
  });

  it('counts totals past 10,000 and returns sort values for search_after', async () => {
    const r = await os.search({
      index: IDX,
      body: JSON.stringify({ query: { match_all: {} }, sort: [{ _id: 'asc' }], size: 5 }),
      size: 5,
    });
    expect(r.total).toBe(10_050);
    expect(r.totalRelation).toBe('eq');
    expect(r.hits[4]?.sort).toBeDefined();
    const next = await os.search({
      index: IDX,
      body: JSON.stringify({
        query: { match_all: {} },
        sort: [{ _id: 'asc' }],
        size: 5,
        search_after: r.hits[4]?.sort,
      }),
      size: 5,
    });
    expect(next.hits[0]?.id).not.toBe(r.hits[0]?.id);
  });

  it('isolates field stats per field and uses keyword multi-fields', async () => {
    const stats = await os.fieldStats({
      index: IDX,
      fields: ['title', 'name', 'sev', 'loc', 'user', 'user.id'],
    });
    const by = Object.fromEntries(stats.map((s) => [s.field, s]));
    expect(by.title?.error).toMatch(/text/);
    expect(by.name?.aggField).toBe('name.keyword');
    expect(by.name?.cardinality).toBe(7);
    expect(by.sev?.cardinality).toBe(3);
    expect(by.loc?.error).toBeTruthy();
    expect(by['user.id']?.cardinality).toBe(5);
  });

  it('merges mapping with multi-fields', async () => {
    const root = await os.mapping(IDX);
    const name = root.children.find((c) => c.name === 'name');
    expect(name?.multiFields).toEqual([{ name: 'keyword', type: 'keyword' }]);
  });

  it('returns HTTP errors as responses from request()', async () => {
    const r = await os.request({ method: 'GET', path: '/plasma-live-missing/_doc/1' });
    expect(r.status).toBe(404);
  });

  it('pages SQL with a cursor', async () => {
    const r = await os.sql({ query: `SELECT sev FROM ${IDX}`, fetchSize: 100 });
    expect(r.rows.length).toBe(100);
    expect(r.cursor).toBeTruthy();
    const next = await os.sql({ query: '', cursor: r.cursor ?? '' });
    expect(next.rows.length).toBe(100);
  });

  it('cancels an in-flight request', async () => {
    const p = os.search({
      index: IDX,
      body: JSON.stringify({ query: { match_all: {} }, size: 10_000 }),
      size: 10_000,
      requestId: 'cancel-me',
    });
    const settled = expect(p).rejects.toThrow(/cancelled/);
    await os.cancel('cancel-me');
    await settled;
  });

  it('refuses writes on a read-only connection', async () => {
    const ro = new OpenSearchDriver();
    await ro.connect(config(true));
    await expect(
      ro.request({ method: 'PUT', path: `/${IDX}/_doc/x`, body: '{"a":1}' }),
    ).rejects.toThrow(/read-only/);
    await expect(ro.deleteIndex(IDX)).rejects.toThrow(/read-only/);
    await expect(ro.sql({ query: `DELETE FROM ${IDX}` })).rejects.toThrow(/read-only/);
    const read = await ro.request({ method: 'POST', path: `/${IDX}/_count` });
    expect(read.status).toBe(200);
    await ro.disconnect();
  });
});
