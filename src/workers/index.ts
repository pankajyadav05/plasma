/// <reference types="electron" />
import { WorkerRequest, type WorkerResponse } from '@shared/protocol';
import { PostgresDriver } from './drivers/postgres';

/**
 * DB worker — runs in an Electron utilityProcess.
 *
 * One persistent PostgresDriver per worker. Handles:
 *   - connect / disconnect
 *   - query execution
 *   - query cancellation (via sideband connection)
 *   - schema introspection
 *   - explicit transactions (BEGIN / COMMIT / ROLLBACK)
 */

const driver = new PostgresDriver();

function send(res: WorkerResponse): void {
  process.parentPort.postMessage(res);
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
        const serverVersion = await driver.connect(req.config);
        send({ kind: 'connected', id: req.id, serverVersion });
        break;
      }
      case 'disconnect':
        await driver.disconnect();
        send({ kind: 'disconnected', id: req.id });
        break;
      case 'query': {
        const result = await driver.query(req.sql, req.params);
        send({ kind: 'queryResult', id: req.id, result });
        break;
      }
      case 'cancel':
        await driver.cancelQuery();
        send({ kind: 'cancelled', id: req.id });
        break;
      case 'introspect': {
        const info = await driver.introspect();
        send({ kind: 'schemaInfo', id: req.id, info });
        break;
      }
      case 'beginTxn': {
        const state = await driver.beginTransaction();
        send({ kind: 'txnState', id: req.id, state });
        break;
      }
      case 'commitTxn': {
        const state = await driver.commitTransaction();
        send({ kind: 'txnState', id: req.id, state });
        break;
      }
      case 'rollbackTxn': {
        const state = await driver.rollbackTransaction();
        send({ kind: 'txnState', id: req.id, state });
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
