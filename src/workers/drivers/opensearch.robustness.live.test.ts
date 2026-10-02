/**
 * Live OpenSearch checks for P2-14 — opt-in: PLASMA_LIVE_OS=http://localhost:9502
 * (security disabled). Seeds and drops its own `plasma-rob-*` index.
 */
import type { ConnectionConfig } from '@shared/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenSearchDriver } from './opensearch';

const LIVE = process.env.PLASMA_LIVE_OS;
const IDX = 'plasma-rob-docs';

function config(): ConnectionConfig {
  const url = new URL(LIVE ?? 'http://localhost:9200');
  return {
    id: 'live-os-rob',
    name: 'live',
    engine: 'opensearch',
    host: url.hostname,
    port: Number(url.port || 9200),
    database: '',
    user: '',
    password: '',
    ssl: url.protocol === 'https:',
    readOnly: false,
  } as ConnectionConfig;
}

describe.skipIf(!LIVE)('OpenSearchDriver robustness (live)', () => {
  const os = new OpenSearchDriver({ maxResponseBytes: 1024 * 1024 });

  beforeAll(async () => {
    await os.connect(config());
    await os.request({ method: 'DELETE', path: `/${IDX}` });
    await os.request({
      method: 'PUT',
      path: `/${IDX}`,
      body: JSON.stringify({ mappings: { properties: { n: { type: 'integer' } } } }),
    });
    let bulk = '';
    for (let i = 1; i <= 30; i++) {
      bulk += `${JSON.stringify({ index: { _index: IDX, _id: String(i) } })}\n`;
      bulk += `${JSON.stringify({ n: i, blob: 'x'.repeat(100 * 1024) })}\n`;
    }
    await os.request({ method: 'POST', path: '/_bulk?refresh=true', body: bulk });
  }, 30_000);

  afterAll(async () => {
    await os.request({ method: 'DELETE', path: `/${IDX}` });
    await os.disconnect();
  });

  it('refuses a response over the cap with a hint, and stays usable', async () => {
    // 30 docs x 100 KB = 3 MB > 1 MB cap
    await expect(os.request({ method: 'GET', path: `/${IDX}/_search?size=30` })).rejects.toThrow(
      /larger than 1 MB.*filter_path/,
    );
    const small = await os.request({ method: 'GET', path: `/${IDX}/_count` });
    expect(small.status).toBe(200);
  });

  it('keeps small and error responses intact through the capped reader', async () => {
    const miss = await os.request({ method: 'GET', path: '/plasma-rob-missing/_search' });
    expect(miss.status).toBe(404);
    const head = await os.request({ method: 'HEAD', path: `/${IDX}` });
    expect(head.status).toBe(200);
  });

  it('closes the SQL cursor the server holds when paging is abandoned or the driver disconnects', async () => {
    const page = await os.sql({ query: `SELECT n FROM ${IDX} ORDER BY n`, fetchSize: 5 });
    expect(page.cursor).toBeTruthy();
    expect(os.openSqlCursorCount()).toBe(1);
    const cursor = page.cursor as string;
    await os.closeSqlCursor(cursor);
    expect(os.openSqlCursorCount()).toBe(0);
    // The server dropped it: paging on now fails.
    await expect(os.sql({ query: '', cursor })).rejects.toThrow();

    const again = await os.sql({ query: `SELECT n FROM ${IDX} ORDER BY n`, fetchSize: 5 });
    expect(again.cursor).toBeTruthy();
    await os.disconnect();
    expect(os.openSqlCursorCount()).toBe(0);
    await os.connect(config());
  });

  it('bounds the number of cursors left open by abandoned paging', async () => {
    for (let i = 0; i < 20; i++) {
      await os.sql({ query: `SELECT n FROM ${IDX} ORDER BY n`, fetchSize: 2 });
    }
    expect(os.openSqlCursorCount()).toBeLessThanOrEqual(16);
  });

  it('a request without a renderer id is still aborted by disconnect', async () => {
    const slow = os.overview().catch((e: unknown) => e);
    // Disconnect aborts whatever is in flight instead of leaving it dangling.
    await os.disconnect();
    const out = await Promise.race([slow, new Promise((r) => setTimeout(() => r('hung'), 5000))]);
    expect(out).not.toBe('hung');
    await os.connect(config());
  });
});
