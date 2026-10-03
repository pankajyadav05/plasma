import { PgListenRequest, PgNotifyRequest } from '@shared/pg-listen';
import { IpcChannel, type WorkerRequest, type WorkerResponse } from '@shared/protocol';
import { ipcMain } from 'electron';

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export interface PgListenIpcDeps {
  callWorker: <K extends WorkerResponse['kind']>(
    req: DistributiveOmit<WorkerRequest, 'id'>,
    expected: K,
  ) => Promise<Extract<WorkerResponse, { kind: K }>>;
  /** Called after a NOTIFY went out, for the audit log. */
  onNotify?: (channel: string, payload: string, error: string | null, durationMs: number) => void;
}

/**
 * LISTEN/NOTIFY tail IPC. Channel names and payloads are validated here;
 * the worker listens on its own connection. `pgNotify` is a write: the
 * read-only guard in callWorker refuses it on read-only connections, and the
 * renderer asks for confirmation according to safe mode first.
 */
export function registerPgListenIpc(deps: PgListenIpcDeps): void {
  ipcMain.handle(IpcChannel.PgListen, async (_e, raw: unknown): Promise<void> => {
    const { channel } = PgListenRequest.parse(raw);
    await deps.callWorker({ kind: 'pgListen', channel }, 'pgListenAck');
  });

  ipcMain.handle(IpcChannel.PgUnlisten, async (_e, raw: unknown): Promise<void> => {
    const { channel } = PgListenRequest.parse(raw);
    await deps.callWorker({ kind: 'pgUnlisten', channel }, 'pgListenAck');
  });

  ipcMain.handle(IpcChannel.PgNotify, async (_e, raw: unknown): Promise<void> => {
    const { channel, payload } = PgNotifyRequest.parse(raw);
    const started = Date.now();
    try {
      await deps.callWorker({ kind: 'pgNotify', channel, payload }, 'pgListenAck');
      deps.onNotify?.(channel, payload, null, Date.now() - started);
    } catch (err) {
      deps.onNotify?.(
        channel,
        payload,
        err instanceof Error ? err.message : String(err),
        Date.now() - started,
      );
      throw err;
    }
  });
}
