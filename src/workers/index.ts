/// <reference types="electron" />
import {
  type ConnectionEngine,
  type RedisPubsubMessage,
  WorkerRequest,
  type WorkerResponse,
} from '@shared/protocol';
import { OpenSearchDriver } from './drivers/opensearch';
import { PostgresDriver } from './drivers/postgres';
import { RedisDriver } from './drivers/redis';

/**
 * DB worker — runs in an Electron utilityProcess.
 *
 * Holds one driver per supported engine but only ONE is "active" at a
 * time (the most recently connected one). Plasma keeps a single active
 * connection per worker so the renderer's tab/panel state stays
 * unambiguous; switching engines means a fresh connect.
 *
 * Dispatch:
 *   - postgres ops      → PostgresDriver
 *   - redis ops         → RedisDriver
 *   - opensearch ops    → OpenSearchDriver
 *   - cross-engine ops  → branch on `activeEngine`
 */

const pg = new PostgresDriver();
const redis = new RedisDriver();
const os = new OpenSearchDriver();

let activeEngine: ConnectionEngine | null = null;

function send(res: WorkerResponse): void {
  process.parentPort.postMessage(res);
}

// One-way pub/sub feed → main → renderer. Worker doesn't correlate
// these to a request; the constant sentinel id lets the supervisor
// route it to its broadcast handler.
redis.setPubsubListener((message: RedisPubsubMessage) => {
  send({ kind: 'redisPubsub', id: 'pubsub-event', message });
});

function unsupported(id: string, op: string): void {
  send({
    kind: 'error',
    id,
    message: `${op} is not supported on ${activeEngine ?? 'no'} engine`,
  });
}

async function disconnectAll(): Promise<void> {
  await Promise.allSettled([pg.disconnect(), redis.disconnect(), os.disconnect()]);
  activeEngine = null;
}

process.parentPort.on('message', async (evt: Electron.MessageEvent) => {
  const parsed = WorkerRequest.safeParse(evt.data);
  if (!parsed.success) {
    send({
      kind: 'error',
      id: 'unknown',
      message: `invalid request: ${parsed.error.message}`,
    });
    return;
  }

  const req = parsed.data;

  try {
    switch (req.kind) {
      case 'ping':
        send({ kind: 'ping', id: req.id, echo: req.message, timestamp: Date.now() });
        break;
      case 'connect': {
        // Always tear down any previous engine before bringing a new
        // one online. Plasma is single-connection at the worker level.
        await disconnectAll();
        const engine = req.config.engine ?? 'postgres';
        let serverVersion = '';
        if (engine === 'postgres') {
          serverVersion = await pg.connect(req.config);
        } else if (engine === 'redis') {
          serverVersion = await redis.connect(req.config);
        } else if (engine === 'opensearch') {
          serverVersion = await os.connect(req.config);
        }
        activeEngine = engine;
        send({ kind: 'connected', id: req.id, serverVersion, engine });
        break;
      }
      case 'disconnect':
        await disconnectAll();
        send({ kind: 'disconnected', id: req.id });
        break;

      // ── Postgres-only ──
      case 'query': {
        if (activeEngine !== 'postgres') return unsupported(req.id, 'query');
        {
          const revision = req.revision ?? 0;
          const result = await pg.query(req.sql, req.params, {
            revision,
            onChunk: (chunk) => {
              send({
                kind: 'queryChunk',
                id: req.id,
                revision,
                columns: chunk.columns,
                rows: chunk.rows,
                chunkIndex: chunk.chunkIndex,
                done: chunk.done,
                truncated: chunk.truncated,
              });
            },
          });
          send({ kind: 'queryResult', id: req.id, result });
        }
        break;
      }
      case 'sidebandQuery': {
        if (activeEngine !== 'postgres') return unsupported(req.id, 'sidebandQuery');
        {
          const revision = req.revision ?? 0;
          const result = await pg.sidebandQuery(req.sql, req.params, {
            revision,
            onChunk: (chunk) => {
              send({
                kind: 'queryChunk',
                id: req.id,
                revision,
                columns: chunk.columns,
                rows: chunk.rows,
                chunkIndex: chunk.chunkIndex,
                done: chunk.done,
                truncated: chunk.truncated,
              });
            },
          });
          send({ kind: 'queryResult', id: req.id, result });
        }
        break;
      }
      case 'cancel':
        if (activeEngine === 'postgres') await pg.cancelQuery();
        send({ kind: 'cancelled', id: req.id });
        break;
      case 'introspect': {
        if (activeEngine === 'postgres') {
          const info = await pg.introspect();
          send({ kind: 'schemaInfo', id: req.id, info });
        } else if (activeEngine === 'redis') {
          const info = await redis.refreshOverview();
          send({ kind: 'redisOverview', id: req.id, info });
        } else if (activeEngine === 'opensearch') {
          const info = await os.overview();
          send({ kind: 'osOverview', id: req.id, info });
        } else {
          unsupported(req.id, 'introspect');
        }
        break;
      }
      case 'beginTxn': {
        if (activeEngine !== 'postgres') return unsupported(req.id, 'beginTxn');
        const state = await pg.beginTransaction();
        send({ kind: 'txnState', id: req.id, state });
        break;
      }
      case 'commitTxn': {
        if (activeEngine !== 'postgres') return unsupported(req.id, 'commitTxn');
        const state = await pg.commitTransaction();
        send({ kind: 'txnState', id: req.id, state });
        break;
      }
      case 'rollbackTxn': {
        if (activeEngine !== 'postgres') return unsupported(req.id, 'rollbackTxn');
        const state = await pg.rollbackTransaction();
        send({ kind: 'txnState', id: req.id, state });
        break;
      }

      // ── Redis ──
      case 'redisScan': {
        if (activeEngine !== 'redis') return unsupported(req.id, 'redisScan');
        const result = await redis.scan({
          cursor: req.cursor,
          match: req.match,
          count: req.count,
          db: req.db,
        });
        send({ kind: 'redisScan', id: req.id, result });
        break;
      }
      case 'redisGetKey': {
        if (activeEngine !== 'redis') return unsupported(req.id, 'redisGetKey');
        const result = await redis.getKey(req.key);
        send({ kind: 'redisKey', id: req.id, result });
        break;
      }
      case 'redisDeleteKey': {
        if (activeEngine !== 'redis') return unsupported(req.id, 'redisDeleteKey');
        await redis.deleteKey(req.key);
        send({ kind: 'redisAck', id: req.id });
        break;
      }
      case 'redisSetTtl': {
        if (activeEngine !== 'redis') return unsupported(req.id, 'redisSetTtl');
        await redis.setTtl(req.key, req.seconds);
        send({ kind: 'redisAck', id: req.id });
        break;
      }
      case 'redisCommand': {
        if (activeEngine !== 'redis') return unsupported(req.id, 'redisCommand');
        const result = await redis.command(req.parts);
        send({ kind: 'redisCommand', id: req.id, result });
        break;
      }
      case 'redisOverview': {
        if (activeEngine !== 'redis') return unsupported(req.id, 'redisOverview');
        const info = await redis.refreshOverview();
        send({ kind: 'redisOverview', id: req.id, info });
        break;
      }
      case 'redisAnalyze': {
        if (activeEngine !== 'redis') return unsupported(req.id, 'redisAnalyze');
        const result = await redis.analyze({ sampleCap: req.sampleCap, match: req.match });
        send({ kind: 'redisAnalyze', id: req.id, result });
        break;
      }
      case 'redisSlowlog': {
        if (activeEngine !== 'redis') return unsupported(req.id, 'redisSlowlog');
        const entries = await redis.slowlog(req.limit);
        send({ kind: 'redisSlowlog', id: req.id, entries });
        break;
      }
      case 'redisBulkDelete': {
        if (activeEngine !== 'redis') return unsupported(req.id, 'redisBulkDelete');
        await redis.bulkDelete(req.keys);
        send({ kind: 'redisAck', id: req.id });
        break;
      }
      case 'redisWrite': {
        if (activeEngine !== 'redis') return unsupported(req.id, 'redisWrite');
        await redis.write(req.op);
        send({ kind: 'redisAck', id: req.id });
        break;
      }
      case 'redisSubscribe': {
        if (activeEngine !== 'redis') return unsupported(req.id, 'redisSubscribe');
        await redis.subscribe(req.channel, req.pattern);
        send({ kind: 'redisAck', id: req.id });
        break;
      }
      case 'redisUnsubscribe': {
        if (activeEngine !== 'redis') return unsupported(req.id, 'redisUnsubscribe');
        await redis.unsubscribe(req.channel, req.pattern);
        send({ kind: 'redisAck', id: req.id });
        break;
      }

      // ── OpenSearch ──
      case 'osOverview': {
        if (activeEngine !== 'opensearch') return unsupported(req.id, 'osOverview');
        const info = await os.overview();
        send({ kind: 'osOverview', id: req.id, info });
        break;
      }
      case 'osMapping': {
        if (activeEngine !== 'opensearch') return unsupported(req.id, 'osMapping');
        const root = await os.mapping(req.index);
        send({ kind: 'osMapping', id: req.id, root });
        break;
      }
      case 'osSearch': {
        if (activeEngine !== 'opensearch') return unsupported(req.id, 'osSearch');
        const result = await os.search({ index: req.index, body: req.body, size: req.size });
        send({ kind: 'osSearch', id: req.id, result });
        break;
      }
      case 'osSql': {
        if (activeEngine !== 'opensearch') return unsupported(req.id, 'osSql');
        const result = await os.sql(req.query);
        send({ kind: 'osSql', id: req.id, result });
        break;
      }
      case 'osAliases': {
        if (activeEngine !== 'opensearch') return unsupported(req.id, 'osAliases');
        const aliases = await os.aliases();
        send({ kind: 'osAliases', id: req.id, aliases });
        break;
      }
      case 'osIlm': {
        if (activeEngine !== 'opensearch') return unsupported(req.id, 'osIlm');
        const policies = await os.ilm();
        send({ kind: 'osIlm', id: req.id, policies });
        break;
      }
      case 'osCreateIndex': {
        if (activeEngine !== 'opensearch') return unsupported(req.id, 'osCreateIndex');
        const result = await os.createIndex(req.name, req.body);
        send({
          kind: 'osCreateIndex',
          id: req.id,
          acknowledged: result.acknowledged,
          index: result.index,
        });
        break;
      }
      case 'osDeleteIndex': {
        if (activeEngine !== 'opensearch') return unsupported(req.id, 'osDeleteIndex');
        const result = await os.deleteIndex(req.name);
        send({ kind: 'osDeleteIndex', id: req.id, acknowledged: result.acknowledged });
        break;
      }
      case 'osFieldStats': {
        if (activeEngine !== 'opensearch') return unsupported(req.id, 'osFieldStats');
        const stats = await os.fieldStats({
          index: req.index,
          fields: req.fields,
          queryString: req.queryString,
        });
        send({ kind: 'osFieldStats', id: req.id, stats });
        break;
      }
    }
  } catch (err) {
    send({
      kind: 'error',
      id: req.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

process.on('uncaughtException', (err) => {
  console.error('[plasma-worker] uncaught:', err);
  // Fall through — let the parent see the stderr and decide to restart.
});

console.log('plasma db worker ready');
