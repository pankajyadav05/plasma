/// <reference types="electron" />
import { CONNECTION_LOST, isConnectionLostError } from '@shared/connection-loss';
import { assertOsSingleIndexName } from '@shared/os-write-policy';
import {
  type ConnectionEngine,
  type PgNotice,
  type RedisPubsubMessage,
  WorkerRequest,
  type WorkerResponse,
} from '@shared/protocol';
import { OpenSearchDriver } from './drivers/opensearch';
import { PostgresDriver } from './drivers/postgres';
import { RedisDriver } from './drivers/redis';
import { dispatchRedis } from './drivers/redis-dispatch';
import { ExportCancelledError, writeExportFromQueryStream, writeExportRows } from './export-file';
import { RequestScheduler } from './request-scheduler';
import { runIsolatedTestConnect } from './test-connect';

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
/** Import jobs the user asked to cancel; polled between batches. */
const importCancelled = new Set<string>();
const runningImports = new Set<string>();
const exportCancelled = new Set<string>();
const redis = new RedisDriver();
const os = new OpenSearchDriver();

let activeEngine: ConnectionEngine | null = null;
const scheduler = new RequestScheduler();
/** Bumped on every successful connect; edit batches must match (U01). */
let connectionGen = 0;

/** Notices a failed statement raised before it errored (P2-6). */
function noticesOf(err: unknown): PgNotice[] | undefined {
  const n = err instanceof Error ? (err as Error & { notices?: PgNotice[] }).notices : undefined;
  return n && n.length > 0 ? n : undefined;
}

function send(res: WorkerResponse): void {
  process.parentPort.postMessage(res);
}

// One-way pub/sub feed → main → renderer. Worker doesn't correlate
// these to a request; the constant sentinel id lets the supervisor
// route it to its broadcast handler.
redis.setPubsubListener((message: RedisPubsubMessage) => {
  send({ kind: 'redisPubsub', id: 'pubsub-event', message });
});

// U26: stream Postgres NOTICE / RAISE NOTICE to main → renderer.
pg.setNoticeListener((notice: PgNotice) => {
  send({ kind: 'pgNotice', id: 'notice-event', notice });
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
  // Keep connectionGen as-is until the next connect bumps it — stale
  // edit batches still fail the write-boundary check because pg's
  // mirrored gen is cleared to 0 on disconnect.
}

process.parentPort.on('message', async (evt: Electron.MessageEvent) => {
  const parsed = WorkerRequest.safeParse(evt.data);
  if (!parsed.success) {
    // Preserve the caller's correlation id when present so the supervisor
    // can settle the original pending promise (U20).
    const rawId =
      evt.data &&
      typeof evt.data === 'object' &&
      'id' in evt.data &&
      typeof (evt.data as { id: unknown }).id === 'string'
        ? (evt.data as { id: string }).id
        : 'unknown';
    send({
      kind: 'error',
      id: rawId,
      message: `invalid request: ${parsed.error.message}`,
    });
    return;
  }

  const req = parsed.data;

  try {
    // C12: connect/disconnect never overlap each other or a statement, and
    // multi-step primary/aux work runs FIFO (see request-scheduler.ts).
    await scheduler.run(req.kind, async () => {
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
            serverVersion = await pg.connect(req.config, req.statementTimeoutMs);
          } else if (engine === 'redis') {
            serverVersion = await redis.connect(req.config);
          } else if (engine === 'opensearch') {
            serverVersion = await os.connect(req.config, req.statementTimeoutMs);
          }
          activeEngine = engine;
          connectionGen += 1;
          if (engine === 'postgres') pg.setConnectionGen(connectionGen);
          send({
            kind: 'connected',
            id: req.id,
            serverVersion,
            engine,
            connectionGen,
          });
          break;
        }
        case 'testConnect': {
          // Isolated probe — throwaway driver, never disconnectAll() on
          // the live session. activeEngine stays untouched.
          const { serverVersion, engine } = await runIsolatedTestConnect(req.config);
          send({ kind: 'connected', id: req.id, serverVersion, engine });
          break;
        }
        case 'setStatementTimeout': {
          if (activeEngine === 'postgres') {
            await pg.setStatementTimeout(req.timeoutMs);
          }
          send({ kind: 'statementTimeoutSet', id: req.id });
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
            // F10: no queryChunk stream — nothing consumes it, and each chunk
            // was a second full copy of the rows across two process hops.
            const result = await pg.query(req.sql, req.params, {
              revision: req.revision ?? 0,
              maxRows: req.maxRows,
              maxBytes: req.maxBytes,
              autoBegin: req.autoBegin,
            });
            send({ kind: 'queryResult', id: req.id, result });
          }
          break;
        }
        case 'commitEditBatch': {
          if (activeEngine !== 'postgres') return unsupported(req.id, 'commitEditBatch');
          const { state, applied } = await pg.commitEditBatch(req.connectionGen, req.updates);
          send({ kind: 'editBatchResult', id: req.id, state, applied });
          break;
        }
        case 'applyDdl': {
          if (activeEngine !== 'postgres') return unsupported(req.id, 'applyDdl');
          const result = await pg.applyDdl(req.request);
          send({ kind: 'ddlResult', id: req.id, result });
          break;
        }
        case 'importRun': {
          if (activeEngine !== 'postgres') return unsupported(req.id, 'importRun');
          const jobId = req.job.jobId;
          importCancelled.delete(jobId);
          runningImports.add(jobId);
          try {
            const result = await pg.runImport(req.job, {
              isCancelled: () => importCancelled.has(jobId),
              onProgress: (p) =>
                send({ kind: 'importProgress', id: 'import-progress', progress: { jobId, ...p } }),
            });
            send({ kind: 'importResult', id: req.id, result });
          } finally {
            importCancelled.delete(jobId);
            runningImports.delete(jobId);
          }
          break;
        }
        case 'importCancel': {
          importCancelled.add(req.jobId);
          // P2-17: a slow statement can't poll the flag; interrupt it server-side
          // (only while that import is the thing running on the primary).
          const delivered =
            activeEngine === 'postgres' && runningImports.has(req.jobId)
              ? await pg.cancelQuery()
              : undefined;
          send({ kind: 'cancelled', id: req.id, delivered });
          break;
        }
        case 'explain': {
          if (activeEngine !== 'postgres') return unsupported(req.id, 'explain');
          const result = await pg.explain(req.sql, req.analyze);
          send({ kind: 'queryResult', id: req.id, result });
          break;
        }
        case 'sidebandQuery': {
          if (activeEngine !== 'postgres') return unsupported(req.id, 'sidebandQuery');
          {
            const result = await pg.sidebandQuery(req.sql, req.params, {
              revision: req.revision ?? 0,
              timeoutMs: req.timeoutMs,
            });
            send({ kind: 'queryResult', id: req.id, result });
          }
          break;
        }
        case 'aiQuery': {
          if (activeEngine !== 'postgres') return unsupported(req.id, 'aiQuery');
          const result = await pg.aiQuery(req.sql, req.params);
          send({ kind: 'queryResult', id: req.id, result });
          break;
        }
        case 'cancel': {
          const delivered = activeEngine === 'postgres' ? await pg.cancelQuery() : undefined;
          send({ kind: 'cancelled', id: req.id, delivered });
          break;
        }
        case 'introspect': {
          if (activeEngine === 'postgres') {
            const info = await pg.introspect(req.opts);
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

        case 'exportRows': {
          if (activeEngine !== 'postgres') return unsupported(req.id, 'exportRows');
          const jobId = req.jobId;
          if (jobId) exportCancelled.delete(jobId);
          try {
            const result = await writeExportRows({
              filePath: req.filePath,
              format: req.format,
              columns: req.columns,
              rows: req.rows,
              targetTable: req.targetTable,
              csv: req.csv,
              isCancelled: () => (jobId ? exportCancelled.has(jobId) : false),
              onProgress: (p) =>
                jobId &&
                send({ kind: 'exportProgress', id: 'export-progress', progress: { jobId, ...p } }),
            });
            send({ kind: 'exportDone', id: req.id, filePath: req.filePath, ...result });
          } finally {
            if (jobId) exportCancelled.delete(jobId);
          }
          break;
        }
        case 'exportQuery': {
          if (activeEngine !== 'postgres') return unsupported(req.id, 'exportQuery');
          const jobId = req.jobId;
          if (jobId) exportCancelled.delete(jobId);
          const isCancelled = () => (jobId ? exportCancelled.has(jobId) : false);
          try {
            // P1-3: the stream is closed inside, whatever fails first.
            const result = await writeExportFromQueryStream(
              pg.streamQueryForExport(req.sql, req.params),
              {
                filePath: req.filePath,
                format: req.format,
                targetTable: req.targetTable,
                csv: req.csv,
                isCancelled,
                onProgress: (p) =>
                  jobId &&
                  send({
                    kind: 'exportProgress',
                    id: 'export-progress',
                    progress: { jobId, ...p },
                  }),
              },
            );
            send({ kind: 'exportDone', id: req.id, filePath: req.filePath, ...result });
          } catch (err) {
            // The server-side cancel surfaces as a pg error; report it as the
            // user's cancel rather than a failure.
            if (isCancelled() && !(err instanceof ExportCancelledError))
              throw new ExportCancelledError();
            throw err;
          } finally {
            if (jobId) exportCancelled.delete(jobId);
          }
          break;
        }
        case 'exportCancel': {
          exportCancelled.add(req.jobId);
          // A long-running fetch is interrupted server-side; the writer also
          // checks the flag between batches.
          const delivered = activeEngine === 'postgres' ? await pg.cancelQuery() : undefined;
          send({ kind: 'cancelled', id: req.id, delivered });
          break;
        }
        case 'cancelAux': {
          const delivered = activeEngine === 'postgres' ? await pg.cancelAux() : undefined;
          send({ kind: 'cancelled', id: req.id, delivered });
          break;
        }

        // ── Redis ── (routing lives in drivers/redis-dispatch.ts)
        case 'redisScan':
        case 'redisGetKey':
        case 'redisDeleteKey':
        case 'redisSetTtl':
        case 'redisCommand':
        case 'redisOverview':
        case 'redisAnalyze':
        case 'redisSlowlog':
        case 'redisBulkDelete':
        case 'redisDeleteByPattern':
        case 'redisCancel':
        case 'redisWrite':
        case 'redisSubscribe':
        case 'redisUnsubscribe': {
          if (activeEngine !== 'redis') return unsupported(req.id, req.kind);
          await dispatchRedis(redis, req, send);
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
          const result = await os.search({
            index: req.index,
            body: req.body,
            size: req.size,
            timeoutMs: req.timeoutMs,
            requestId: req.requestId,
          });
          send({ kind: 'osSearch', id: req.id, result });
          break;
        }
        case 'osSql': {
          if (activeEngine !== 'opensearch') return unsupported(req.id, 'osSql');
          const result = await os.sql({
            query: req.query,
            fetchSize: req.fetchSize,
            cursor: req.cursor,
            timeoutMs: req.timeoutMs,
            requestId: req.requestId,
          });
          send({ kind: 'osSql', id: req.id, result });
          break;
        }
        case 'osRequest': {
          if (activeEngine !== 'opensearch') return unsupported(req.id, 'osRequest');
          const response = await os.request({
            method: req.method,
            path: req.path,
            body: req.body,
            timeoutMs: req.timeoutMs,
            requestId: req.requestId,
          });
          send({ kind: 'osResponse', id: req.id, response });
          break;
        }
        case 'osCancel': {
          if (activeEngine === 'opensearch') await os.cancel(req.requestId);
          send({ kind: 'cancelled', id: req.id });
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
          assertOsSingleIndexName(req.name);
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
          assertOsSingleIndexName(req.name);
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
            query: req.query,
            requestId: req.requestId,
            timeoutMs: req.timeoutMs,
          });
          send({ kind: 'osFieldStats', id: req.id, stats });
          break;
        }
      }
    });
  } catch (err) {
    // U27: distinguish "the transport is gone" from "the server said no"
    // so main can reconnect and retry instead of handing the renderer a
    // permanently dead session.
    send({
      kind: 'error',
      id: req.id,
      message: err instanceof Error ? err.message : String(err),
      fatal: isConnectionLostError(err) ? CONNECTION_LOST : undefined,
      // C5: main must not replay anything into a fresh session when the
      // old one died with a transaction open.
      txnLost: isConnectionLostError(err) && pg.lostDuringTransaction() ? true : undefined,
      notices: noticesOf(err),
    });
  }
});

process.on('uncaughtException', (err) => {
  console.error('[plasma-worker] uncaught:', err);
  // Installing this handler suppresses Node's default fatal exit; exit
  // explicitly so the supervisor can restart (U20).
  process.exit(1);
});

// Readiness handshake for the supervisor (U20).
send({ kind: 'ready', id: 'boot' });
console.log('plasma db worker ready');
