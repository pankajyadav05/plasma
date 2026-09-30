import { open, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { formatFromPath } from '@shared/import-parse';
import { PREVIEW_SAMPLE_BYTES, buildImportPreview } from '@shared/import-preview';
import {
  DdlApplyRequest,
  type DdlApplyResult,
  ImportJobSpec,
  type ImportPickedFile,
  type ImportPreview,
  ImportPreviewRequest,
  type ImportResult,
  IpcChannel,
  type WorkerRequest,
  type WorkerResponse,
} from '@shared/protocol';
import { type BrowserWindow, dialog, ipcMain } from 'electron';

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export interface ImportIpcDeps {
  window: () => BrowserWindow | null;
  isReadOnly: () => boolean;
  callWorker: <K extends WorkerResponse['kind']>(
    req: DistributiveOmit<WorkerRequest, 'id'>,
    expected: K,
  ) => Promise<Extract<WorkerResponse, { kind: K }>>;
}

const READ_ONLY_MESSAGE = 'This connection is read-only — it cannot be changed.';

/** Read the first `bytes` of a file as UTF-8 without splitting a code point. */
async function readHead(path: string, bytes: number): Promise<{ text: string; size: number }> {
  const size = (await stat(path)).size;
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(Math.min(size, bytes));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    let end = bytesRead;
    // Back off a partial multi-byte sequence at the cut.
    if (bytesRead < size) {
      while (end > 0 && ((buf[end - 1] as number) & 0xc0) === 0x80) end--;
      if (end > 0 && (buf[end - 1] as number) >= 0xc0) end--;
    }
    return { text: buf.subarray(0, end).toString('utf8'), size };
  } finally {
    await fh.close();
  }
}

/**
 * Paths the user picked in the native dialog. Preview/run only accept these,
 * so a compromised renderer can't read arbitrary files through the importer.
 */
const pickedPaths = new Set<string>();

function assertPicked(path: string): void {
  if (!pickedPaths.has(path)) throw new Error('Pick the file to import first.');
}

export function registerImportIpc(deps: ImportIpcDeps): void {
  ipcMain.handle(IpcChannel.StructureApply, async (_e, raw: unknown): Promise<DdlApplyResult> => {
    const req = DdlApplyRequest.parse(raw);
    if (deps.isReadOnly()) throw new Error(READ_ONLY_MESSAGE);
    const res = await deps.callWorker({ kind: 'applyDdl', request: req }, 'ddlResult');
    return res.result;
  });

  ipcMain.handle(IpcChannel.ImportPickFile, async (): Promise<ImportPickedFile | null> => {
    const win = deps.window();
    const opts = {
      title: 'Import into table',
      properties: ['openFile' as const],
      filters: [
        { name: 'Data files', extensions: ['csv', 'tsv', 'txt', 'json', 'ndjson', 'jsonl', 'sql'] },
        { name: 'All files', extensions: ['*'] },
      ],
    };
    const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    const path = picked.filePaths[0];
    if (picked.canceled || !path) return null;
    const size = (await stat(path)).size;
    pickedPaths.add(path);
    return { path, name: basename(path), size, format: formatFromPath(path) };
  });

  ipcMain.handle(IpcChannel.ImportPreview, async (_e, raw: unknown): Promise<ImportPreview> => {
    const req = ImportPreviewRequest.parse(raw);
    assertPicked(req.path);
    const { text, size } = await readHead(req.path, PREVIEW_SAMPLE_BYTES);
    return buildImportPreview(req, text, size, size > PREVIEW_SAMPLE_BYTES);
  });

  ipcMain.handle(IpcChannel.ImportRun, async (_e, raw: unknown): Promise<ImportResult> => {
    const job = ImportJobSpec.parse(raw);
    if (deps.isReadOnly()) throw new Error(READ_ONLY_MESSAGE);
    assertPicked(job.filePath);
    const res = await deps.callWorker({ kind: 'importRun', job }, 'importResult');
    return res.result;
  });

  ipcMain.handle(IpcChannel.ImportCancel, async (_e, jobId: unknown): Promise<void> => {
    if (typeof jobId !== 'string' || !jobId) return;
    await deps.callWorker({ kind: 'importCancel', jobId }, 'cancelled');
  });
}
