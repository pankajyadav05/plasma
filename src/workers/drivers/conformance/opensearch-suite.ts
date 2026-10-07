import { isConnectionLostError } from '@shared/connection-loss';
import type { ConnectionConfig } from '@shared/protocol';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { OpenSearchDriver } from '../opensearch';
import { allCapabilities } from './capabilities';
import { listOptOuts, scenarioFor } from './scenario';
import { FlakyProxy } from './tcp-proxy';

/**
 * The subset of the conformance scenarios that applies to OpenSearch:
 * connect, introspect, query, cancel, read-only, errors, caps, connection loss.
 *
 * `PLASMA_LIVE_OS=http://host:port` (security disabled, as in CI). The suite
 * creates and drops its own `plasma-conf-*` indices.
 */
export const OPENSEARCH_URL = process.env.PLASMA_LIVE_OS;

export const opensearchCaps = allCapabilities({
  badCredentials: { no: 'the conformance cluster runs with the security plugin disabled' },
  primaryKeys: {
    no: 'documents are keyed by _id; there are no tables or key columns to introspect',
  },
  foreignKeys: { no: 'OpenSearch has no relations' },
  constraints: { no: 'OpenSearch enforces no constraints beyond mappings' },
  transactions: { no: 'OpenSearch has no transactions' },
  multiStatement: { no: 'a request is one call; the Dev Tools console sends them one by one' },
  aiQuery: { no: 'the agent reads OpenSearch through the same classified read-only requests' },
  rowEdit: {
    no: 'documents are edited through document requests (PUT / POST _update), not row edits',
  },
  keylessEdit: { no: 'there are no tables, so no key-less rows' },
  exportStream: { no: 'results are paged with search_after / SQL cursors, not streamed' },
  exactDecimal: {
    no: 'documents are JSON; numbers are typed by the mapping, not by a column type',
  },
  timestamptz: { no: 'dates are strings in _source' },
  json: { no: 'documents are JSON already' },
  binary: { no: 'binary fields are base64 text in _source' },
  arrays: { no: 'arrays are plain JSON arrays in _source' },
});

export function registerOpenSearchConformance(opts: { enabled: boolean }): void {
  const suite = opts.enabled ? describe : describe.skip;
  suite('conformance: opensearch', () => {
    const scenario = scenarioFor(opensearchCaps);
    const url = new URL(OPENSEARCH_URL ?? 'http://127.0.0.1:9200');
    const host = url.hostname;
    const port = Number(url.port || 9200);
    const IDX = `plasma-conf-${process.pid}`;
    const YELLOW = `plasma-conf-yellow-${process.pid}`;
    const config = (
      o: { readOnly?: boolean; host?: string; port?: number } = {},
    ): ConnectionConfig =>
      ({
        id: 'conf-os',
        name: 'conf',
        engine: 'opensearch',
        host: o.host ?? host,
        port: o.port ?? port,
        database: '',
        user: '',
        password: '',
        ssl: url.protocol === 'https:',
        readOnly: o.readOnly === true,
      }) as ConnectionConfig;

    const drivers: OpenSearchDriver[] = [];
    let os: OpenSearchDriver;
    let proxy: FlakyProxy;
    const open = async (
      o: Parameters<typeof config>[0] = {},
      ctor?: { maxResponseBytes?: number },
    ) => {
      const d = new OpenSearchDriver(ctor);
      drivers.push(d);
      await d.connect(config(o));
      return d;
    };
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const rejection = async (p: Promise<unknown>): Promise<Error> => {
      try {
        await p;
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        return err as Error;
      }
      throw new Error('expected the call to be rejected, but it resolved');
    };
    const count = async (d: OpenSearchDriver = os) => {
      const res = await d.request({ method: 'POST', path: `/${IDX}/_count` });
      return (res.body as { count: number }).count;
    };
    const SLOW = `/_cluster/health/${YELLOW}?wait_for_status=green&timeout=30s`;

    beforeAll(async () => {
      proxy = new FlakyProxy(host, port);
      await proxy.start();
      os = await open();
      for (const name of [IDX, YELLOW]) await os.request({ method: 'DELETE', path: `/${name}` });
      await os.request({
        method: 'PUT',
        path: `/${IDX}`,
        body: JSON.stringify({
          settings: { number_of_replicas: 0 },
          mappings: {
            properties: {
              title: { type: 'text' },
              name: { type: 'text', fields: { keyword: { type: 'keyword' } } },
              big: { type: 'long' },
              note: { type: 'keyword', null_value: 'NULL' },
              day: { type: 'date' },
            },
          },
        }),
      });
      // One replica on a one-node cluster never turns green: a request that waits for it is slow on purpose.
      await os.request({
        method: 'PUT',
        path: `/${YELLOW}`,
        body: JSON.stringify({ settings: { number_of_replicas: 1, number_of_shards: 1 } }),
      });
      let bulk = '';
      for (let i = 1; i <= 10_050; i++) {
        bulk += `${JSON.stringify({ index: { _index: IDX, _id: String(i) } })}\n`;
        bulk += `${JSON.stringify({ title: `t ${i}`, name: `n${i % 7}`, big: i, day: '2024-02-29' })}\n`;
      }
      bulk += `${JSON.stringify({ index: { _index: IDX, _id: 'uni' } })}\n`;
      // Written as text: a JS number literal would already have lost the last digit.
      bulk += `{"title":"héllo 日本語 🎉","name":"","note":null,"big":9007199254740993}\n`;
      const res = await os.request({ method: 'POST', path: '/_bulk?refresh=true', body: bulk });
      expect(res.status).toBe(200);
    }, 90_000);

    afterAll(async () => {
      for (const name of [IDX, YELLOW]) {
        await os?.request({ method: 'DELETE', path: `/${name}` }).catch(() => undefined);
      }
      await Promise.allSettled(drivers.map((d) => d.disconnect()));
      await proxy?.stop();
    }, 30_000);

    describe('connect', () => {
      scenario('connect resolves with the server version', null, async () => {
        const d = new OpenSearchDriver();
        drivers.push(d);
        expect(await d.connect(config())).toMatch(/^\d+\.\d+\.\d+/);
        await d.disconnect();
      });

      scenario(
        'disconnect is idempotent and a disconnected driver refuses requests',
        null,
        async () => {
          const d = await open();
          await d.disconnect();
          await d.disconnect();
          await rejection(d.request({ method: 'GET', path: '/' }));
        },
      );

      scenario('the same driver connects again after disconnect', 'reconnect', async () => {
        const d = await open();
        await d.disconnect();
        expect(await d.connect(config())).toMatch(/^\d+\.\d+\.\d+/);
        expect((await d.request({ method: 'GET', path: '/' })).status).toBe(200);
      });

      scenario('connect() on a live driver replaces its session', 'reconnect', async () => {
        const d = await open();
        await d.connect(config());
        expect((await d.request({ method: 'GET', path: '/' })).status).toBe(200);
      });
    });

    describe('introspection', () => {
      scenario('the overview lists the index with its document count', null, async () => {
        const o = await os.overview();
        const entry = o.indices.find((i) => i.index === IDX);
        expect(entry).toBeDefined();
        expect(entry?.docsCount).toBe(10_051);
      });

      scenario(
        'the mapping names every field with its type, multi-fields included',
        null,
        async () => {
          const root = await os.mapping(IDX);
          const by = Object.fromEntries(root.children.map((c) => [c.name, c]));
          expect(by.big?.type).toBe('long');
          expect(by.day?.type).toBe('date');
          expect(by.title?.type).toBe('text');
          expect(by.name?.multiFields).toEqual([{ name: 'keyword', type: 'keyword' }]);
        },
      );
    });

    describe('values', () => {
      scenario(
        'unicode survives, an empty string stays empty and a null stays null',
        null,
        async () => {
          const r = await os.search({
            index: IDX,
            body: JSON.stringify({ query: { ids: { values: ['uni'] } } }),
            size: 1,
          });
          const src = r.hits[0]?.source as Record<string, unknown>;
          expect(src.title).toBe('héllo 日本語 🎉');
          expect(src.name).toBe('');
          expect(src.note).toBeNull();
          expect('missing' in src).toBe(false);
        },
      );

      scenario('a number beyond 2^53 keeps every digit', 'bigint', async () => {
        const r = await os.search({
          index: IDX,
          body: JSON.stringify({ query: { ids: { values: ['uni'] } } }),
          size: 1,
        });
        const big = (r.hits[0]?.source as { big: unknown }).big;
        expect(String(big)).toBe('9007199254740993');
      });
    });

    describe('writes', () => {
      scenario(
        'a number beyond 2^53 typed into a document is stored exactly',
        'bigint',
        async () => {
          const put = await os.request({
            method: 'PUT',
            path: `/${IDX}/_doc/exact?refresh=true`,
            body: '{"big": 9007199254740993}',
          });
          expect([200, 201]).toContain(put.status);
          const got = await os.request({ method: 'GET', path: `/${IDX}/_doc/exact` });
          expect(String((got.body as { _source: { big: unknown } })._source.big)).toBe(
            '9007199254740993',
          );
          // The same number inside a query matches that document, not its rounded neighbour.
          const hit = await os.search({
            index: IDX,
            body: JSON.stringify({ query: { term: { big: '9007199254740993' } } }),
            size: 5,
          });
          expect(hit.hits.map((h) => h.id)).toContain('exact');
          const typed = await os.search({
            index: IDX,
            body: '{"query":{"term":{"big":9007199254740993}}}',
            size: 5,
          });
          expect(typed.hits.map((h) => h.id)).toContain('exact');
          await os.request({ method: 'DELETE', path: `/${IDX}/_doc/exact?refresh=true` });
        },
      );
    });

    describe('errors', () => {
      scenario(
        'a malformed query is an error with the server reason, and the session survives',
        'errorKeepsSession',
        async () => {
          const err = await rejection(
            os.search({ index: IDX, body: JSON.stringify({ query: { nope: {} } }), size: 1 }),
          );
          expect(err.message).toMatch(/nope|parsing|unknown query|x_content/i);
          expect(isConnectionLostError(err)).toBe(false);
          expect(await count()).toBe(10_051);
        },
      );

      scenario('an HTTP error status comes back as a response, not a throw', null, async () => {
        const res = await os.request({ method: 'GET', path: `/${IDX}-missing/_doc/1` });
        expect(res.status).toBe(404);
        const bad = await os.request({
          method: 'PUT',
          path: `/${IDX}/_doc/x`,
          body: '{"big":"not a number"}',
        });
        expect(bad.status).toBe(400);
        expect((await os.request({ method: 'GET', path: '/' })).status).toBe(200);
      });

      scenario('a body that is not JSON is refused before it is sent', null, async () => {
        const err = await rejection(
          os.request({ method: 'POST', path: `/${IDX}/_search`, body: '{nope' }),
        );
        expect(err.message).toMatch(/invalid JSON/i);
      });
    });

    describe('cancellation', () => {
      scenario('cancel on an unknown request id is a no-op', 'cancel', async () => {
        await expect(os.cancel('no-such-request')).resolves.toBeUndefined();
      });

      scenario(
        'a slow request is cancelled within 2 s and the session survives',
        'cancel',
        async () => {
          const d = await open();
          const slow = d.request({ method: 'GET', path: SLOW, requestId: 'conf-cancel' });
          const settled = slow.then(
            () => null,
            (e: Error) => e,
          );
          await sleep(400);
          const asked = Date.now();
          await d.cancel('conf-cancel');
          const err = await settled;
          expect(Date.now() - asked).toBeLessThan(2000);
          expect(err?.message).toMatch(/cancelled/);
          expect((await d.request({ method: 'GET', path: '/' })).status).toBe(200);
        },
      );

      scenario('a request timeout stops a slow request', 'statementTimeout', async () => {
        const started = Date.now();
        const err = await rejection(os.request({ method: 'GET', path: SLOW, timeoutMs: 600 }));
        expect(Date.now() - started).toBeLessThan(5000);
        expect(err.message).toMatch(/timed out/i);
        expect((await os.request({ method: 'GET', path: '/' })).status).toBe(200);
      });
    });

    describe('read-only', () => {
      const writes: Array<[string, string, string?]> = [
        ['PUT', `/${IDX}/_doc/ro`, '{"big":1}'],
        ['POST', `/${IDX}/_doc`, '{"big":1}'],
        ['POST', `/${IDX}/_update/1`, '{"doc":{"big":5}}'],
        ['DELETE', `/${IDX}/_doc/1`],
        ['POST', `/${IDX}/_delete_by_query`, '{"query":{"match_all":{}}}'],
        ['POST', `/${IDX}/_update_by_query`, '{"query":{"match_all":{}}}'],
        ['POST', '/_bulk', `{"delete":{"_index":"${IDX}","_id":"1"}}`],
        ['POST', '/_reindex', `{"source":{"index":"${IDX}"},"dest":{"index":"${IDX}-copy"}}`],
        ['PUT', '/_cluster/settings', '{"persistent":{}}'],
        ['POST', `/${IDX}/_close`],
        ['POST', `/${IDX}/_forcemerge`],
        ['DELETE', `/${IDX}`],
        ['PUT', `/${IDX}-new`, '{}'],
        ['POST', '/_scripts/conf', '{"script":{"lang":"painless","source":"1"}}'],
        ['POST', '/_snapshot/conf/snap'],
      ];
      // The same writes in a form a naive filter misses.
      const disguised: Array<[string, string, string?]> = [
        ['delete', `/${IDX}/_doc/1`],
        ['Put', `/${IDX}/_doc/ro`, '{"big":1}'],
        ['POST', `//${IDX}/_doc`, '{"big":1}'],
        ['POST', `/${IDX}/_doc/?refresh=true`, '{"big":1}'],
        ['POST', `/${IDX}/_search/../_doc`, '{"big":1}'],
        ['POST', `/${IDX}/_search?x=1/../../_doc`, '{"big":1}'],
        ['POST', `/${IDX}/_doc/_search`, '{"big":1}'],
        ['POST', `/${IDX}/_%64elete_by_query`, '{"query":{"match_all":{}}}'],
        ['POST', '/_search', '{"query":{"match_all":{}}}\n{"index":"x"}'],
        ['GET', `/${IDX}/_doc/1?_source=false&version=1&op_type=create`, '{"x":1}'],
      ];

      scenario(
        'a read-only connection refuses writes and changes nothing',
        'readOnlyConnection',
        async () => {
          const before = await count();
          const ro = await open({ readOnly: true });
          for (const [method, path, body] of writes) {
            const err = await rejection(ro.request({ method, path, body }));
            expect(err.message, `${method} ${path}`).toMatch(/read-only/i);
          }
          await rejection(ro.createIndex(`${IDX}-new`, {}));
          await rejection(ro.deleteIndex(IDX));
          await rejection(ro.sql({ query: `DELETE FROM ${IDX} WHERE big = 1` }));
          expect(await count()).toBe(before);
          expect((await os.request({ method: 'HEAD', path: `/${IDX}-new` })).status).toBe(404);
        },
      );

      scenario(
        'a read-only connection still reads, with every read form',
        'readOnlyConnection',
        async () => {
          const ro = await open({ readOnly: true });
          expect(await count(ro)).toBe(10_051);
          const r = await ro.search({ index: IDX, body: '{"query":{"match_all":{}}}', size: 3 });
          expect(r.hits).toHaveLength(3);
          const mget = await ro.request({
            method: 'POST',
            path: '/_mget',
            body: JSON.stringify({ docs: [{ _index: IDX, _id: '1' }] }),
          });
          expect(mget.status).toBe(200);
          expect((await ro.request({ method: 'GET', path: `/${IDX}/_doc/1` })).status).toBe(200);
          const sql = await ro.sql({ query: `SELECT big FROM ${IDX} WHERE big = 1` });
          expect(sql.rows).toEqual([[1]]);
        },
      );

      scenario('a write dressed up as a read is still refused', 'readOnlyBypass', async () => {
        const before = await count();
        const ro = await open({ readOnly: true });
        for (const [method, path, body] of disguised) {
          // Refused outright, or sent as the read it really is; what matters is that nothing is written.
          await ro.request({ method, path, body }).catch(() => undefined);
          expect(await count(), `${method} ${path}`).toBe(before);
        }
        const doc = await os.request({ method: 'GET', path: `/${IDX}/_doc/1` });
        expect((doc.body as { _source: { big: number } })._source.big).toBe(1);
      });
    });

    describe('result caps', () => {
      scenario('a search past the page size reports the true total', 'resultCap', async () => {
        const r = await os.search({ index: IDX, body: '{"query":{"match_all":{}}}', size: 500 });
        expect(r.hits).toHaveLength(500);
        expect(r.total).toBe(10_051);
        expect(r.totalRelation).toBe('eq');
      });

      scenario('a response over the byte cap is refused, not buffered', 'byteCap', async () => {
        const small = await open({}, { maxResponseBytes: 5_000 });
        const err = await rejection(
          small.search({ index: IDX, body: '{"query":{"match_all":{}}}', size: 500 }),
        );
        expect(err.message).toMatch(/larger than/i);
        expect(isConnectionLostError(err)).toBe(false);
        // A small answer still works on the same session.
        expect((await small.request({ method: 'GET', path: '/' })).status).toBe(200);
      });
    });

    describe('connection loss', () => {
      scenario(
        'losing the server is reported as a lost connection, and reconnect works',
        'connectionLoss',
        async () => {
          const d = await open({ host: '127.0.0.1', port: proxy.port });
          expect((await d.request({ method: 'GET', path: '/' })).status).toBe(200);
          await proxy.kill();
          await sleep(300);
          const err = await rejection(d.request({ method: 'GET', path: '/' }));
          expect(isConnectionLostError(err), err.message).toBe(true);
          await proxy.restart();
          await d.connect(config({ host: '127.0.0.1', port: proxy.port }));
          expect((await d.request({ method: 'GET', path: '/' })).status).toBe(200);
        },
        60_000,
      );

      scenario(
        'losing the server under a running request rejects it',
        'connectionLoss',
        async () => {
          const d = await open({ host: '127.0.0.1', port: proxy.port });
          const running = d.request({ method: 'GET', path: SLOW }).then(
            () => null,
            (e: Error) => e,
          );
          await sleep(500);
          const killedAt = Date.now();
          await proxy.kill();
          const err = await running;
          expect(Date.now() - killedAt).toBeLessThan(15_000);
          expect(err).toBeInstanceOf(Error);
          expect(isConnectionLostError(err), err?.message).toBe(true);
          await proxy.restart();
          await d.connect(config({ host: '127.0.0.1', port: proxy.port }));
          expect((await d.request({ method: 'GET', path: '/' })).status).toBe(200);
        },
        60_000,
      );
    });

    describe('opt-outs', () => {
      listOptOuts(opensearchCaps);
    });
  });
}
