/**
 * OpenSearch health advisor against a real node — opt-in:
 * PLASMA_LIVE_OS=http://127.0.0.1:9601 (security disabled, single node).
 * A one-node cluster with a replica is the classic yellow index.
 */
import {
  explainAllocation,
  interpretClusterHealth,
  interpretDisks,
  interpretHotThreads,
  parseNodeDisks,
  parseUnassignedShards,
  parseWatermarks,
  summarizeHotThreads,
} from '@shared/health/os-health';
import type { ConnectionConfig } from '@shared/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenSearchDriver } from './opensearch';

const LIVE = process.env.PLASMA_LIVE_OS;
const IDX = 'plasma-health-yellow';

function config(readOnly = false): ConnectionConfig {
  const url = new URL(LIVE ?? 'http://localhost:9200');
  return {
    id: 'live-os-health',
    name: 'live',
    engine: 'opensearch',
    host: url.hostname,
    port: Number(url.port || 9200),
    database: '',
    user: '',
    password: '',
    ssl: false,
    readOnly,
  } as ConnectionConfig;
}

describe.skipIf(!LIVE)('OpenSearch health advisor (live)', { timeout: 60_000 }, () => {
  const os = new OpenSearchDriver();
  const ro = new OpenSearchDriver();

  const get = async (path: string) => (await os.request({ method: 'GET', path })).body;

  beforeAll(async () => {
    await os.connect(config());
    await ro.connect(config(true));
    await os.request({ method: 'DELETE', path: `/${IDX}` });
    await os.request({
      method: 'PUT',
      path: `/${IDX}`,
      body: JSON.stringify({ settings: { number_of_shards: 1, number_of_replicas: 1 } }),
    });
    await os.request({
      method: 'GET',
      path: '/_cluster/health?wait_for_status=yellow&timeout=20s',
    });
  });

  afterAll(async () => {
    await os.request({ method: 'DELETE', path: `/${IDX}` }).catch(() => {});
    await os.disconnect();
    await ro.disconnect();
  });

  it('explains a yellow index in plain language', async () => {
    const shards = parseUnassignedShards(
      await get('/_cat/shards?format=json&h=index,shard,prirep,state,unassigned.reason'),
    );
    const mine = shards.find((s) => s.index === IDX);
    expect(mine).toBeDefined();
    expect(mine?.primary).toBe(false);

    const res = await os.request({
      method: 'POST',
      path: '/_cluster/allocation/explain',
      body: JSON.stringify({ index: IDX, shard: 0, primary: false }),
    });
    const exp = explainAllocation(res.body);
    expect(exp?.causes.join(' ')).toMatch(/already holds a copy/);
    expect(exp?.fix).toMatch(/data node|number_of_replicas/);

    const health = await get('/_cluster/health?level=indices');
    const r = interpretClusterHealth(health, exp ? [exp] : [], shards);
    const f = r.findings.find((x) => x.id === `index:${IDX}`);
    expect(f?.status).toBe('warn');
    expect(f?.title).toContain('yellow');
    expect(f?.evidence).toMatch(/copy/);
  });

  it('allows the explain POST on a read-only connection but not other writes', async () => {
    const ok = await ro.request({
      method: 'POST',
      path: '/_cluster/allocation/explain',
      body: JSON.stringify({ index: IDX, shard: 0, primary: false }),
    });
    expect(ok.status).toBeLessThan(400);
    await expect(ro.request({ method: 'DELETE', path: `/${IDX}` })).rejects.toThrow();
  });

  it('reads disk watermarks and per-node usage', async () => {
    const disks = parseNodeDisks(await get('/_cat/allocation?format=json&bytes=b'));
    expect(disks.length).toBeGreaterThanOrEqual(1);
    expect(disks[0]?.totalBytes).toBeGreaterThan(0);
    const marks = parseWatermarks(
      await get('/_cluster/settings?include_defaults=true&flat_settings=true'),
    );
    expect(marks.low).toMatch(/%|b$/);
    const r = interpretDisks(disks, marks);
    expect(['ok', 'warn', 'crit']).toContain(r.status);
  });

  it('summarises hot threads from the plain-text report', async () => {
    const body = await get('/_nodes/hot_threads?threads=3&interval=500ms');
    expect(typeof body).toBe('string');
    const s = summarizeHotThreads(body as string);
    expect(s.length).toBeGreaterThanOrEqual(1);
    expect(interpretHotThreads(s).summary).toContain('node(s) sampled');
  });
});
