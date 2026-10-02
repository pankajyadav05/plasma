import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { type CsvOptions, type ExportFormat, createExportStreamer } from '@shared/export-format';
import type { ColumnMeta } from '@shared/protocol';

/** Thrown when an export is cancelled; main maps it to a quiet "cancelled" result. */
export class ExportCancelledError extends Error {
  override readonly name = 'ExportCancelledError';
  constructor() {
    super('export cancelled');
  }
}

/** Thrown for any failure to create / write / finalize the destination file. */
export class ExportFileError extends Error {
  override readonly name = 'ExportFileError';
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Could not write the export file: ${detail}`);
    this.cause = cause;
  }
}

async function writeChunk(
  stream: ReturnType<typeof createWriteStream>,
  chunk: string,
  failure: () => Error | null,
): Promise<void> {
  const failed = failure();
  if (failed) throw failed;
  return new Promise((resolve, reject) => {
    stream.write(chunk, (err) => {
      if (err) reject(new ExportFileError(err));
      else resolve();
    });
  });
}

/**
 * Stream formatted rows to a file path. Never retains the full document
 * string — each batch is written and released (U16).
 *
 * F7: rows go to a sibling temp file that is renamed over the destination
 * only once everything was written, so a failed or cancelled export never
 * leaves a truncated file behind (or clobbers a good one).
 */
export async function writeExportFile(opts: {
  filePath: string;
  format: ExportFormat;
  columns: readonly ColumnMeta[];
  batches: AsyncIterable<readonly unknown[][]>;
  /** Quoted `schema.table` INSERT target for SQL export. */
  targetTable?: string;
  csv?: CsvOptions;
  /** Checked between batches; true aborts and removes the partial file (C30). */
  isCancelled?: () => boolean;
  /** Called after every batch is written. */
  onProgress?: (p: { rowCount: number; bytesWritten: number }) => void;
}): Promise<{ rowCount: number; bytesWritten: number }> {
  const tempPath = `${opts.filePath}.${process.pid}-${Date.now()}.partial`;
  const stream = createWriteStream(tempPath, { encoding: 'utf8' });
  // P0-1: Node also emits 'error' on the stream (ENOENT, EACCES, ENOSPC...).
  // Without a listener that is an uncaught exception and kills the worker.
  let streamError: Error | null = null;
  stream.on('error', (err) => {
    streamError ??= new ExportFileError(err);
  });
  const failure = () => streamError;
  let bytesWritten = 0;
  let rowCount = 0;
  let pending: Promise<void> = Promise.resolve();

  const sink = (chunk: string) => {
    bytesWritten += Buffer.byteLength(chunk, 'utf8');
    pending = pending.then(() => writeChunk(stream, chunk, failure));
  };

  const streamer = createExportStreamer(opts.format, opts.columns, sink, {
    targetTable: opts.targetTable,
    csv: opts.csv,
  });
  try {
    streamer.begin();
    await pending;

    for await (const batch of opts.batches) {
      if (opts.isCancelled?.()) throw new ExportCancelledError();
      streamer.writeRows(batch as unknown[][]);
      rowCount += batch.length;
      await pending;
      opts.onProgress?.({ rowCount, bytesWritten });
    }

    streamer.end();
    await pending;
    if (streamError) throw streamError;
    stream.end();
    await finished(stream).catch((err) => {
      throw streamError ?? new ExportFileError(err);
    });
    await rename(tempPath, opts.filePath).catch((err) => {
      throw new ExportFileError(err);
    });
  } catch (err) {
    stream.destroy();
    await rm(tempPath, { force: true }).catch(() => {});
    // A rejected `pending` chain can still be rejected after we leave; keep it handled.
    pending.catch(() => {});
    throw streamError && !(err instanceof ExportCancelledError) ? streamError : err;
  }

  return { rowCount, bytesWritten };
}

/** Convenience for in-memory row arrays (selection / capped results). */
export async function writeExportRows(opts: {
  filePath: string;
  format: ExportFormat;
  columns: readonly ColumnMeta[];
  rows: readonly unknown[][];
  batchSize?: number;
  targetTable?: string;
  csv?: CsvOptions;
  isCancelled?: () => boolean;
  onProgress?: (p: { rowCount: number; bytesWritten: number }) => void;
}): Promise<{ rowCount: number; bytesWritten: number }> {
  const batchSize = opts.batchSize ?? 500;
  async function* batches() {
    for (let i = 0; i < opts.rows.length; i += batchSize) {
      yield opts.rows.slice(i, i + batchSize);
    }
  }
  return writeExportFile({
    filePath: opts.filePath,
    format: opts.format,
    columns: opts.columns,
    batches: batches(),
    targetTable: opts.targetTable,
    csv: opts.csv,
    isCancelled: opts.isCancelled,
    onProgress: opts.onProgress,
  });
}

/**
 * Export a pulled-from-the-server cursor stream (P1-3). This owns the
 * generator: it is always closed here, so a failure on the first write or
 * a cancel at the first check can no longer leave the server cursor open
 * and wedge the connection behind it.
 */
export async function writeExportFromQueryStream(
  stream: AsyncGenerator<{ columns: readonly ColumnMeta[]; rows: unknown[][] }, void, void>,
  opts: Omit<Parameters<typeof writeExportFile>[0], 'columns' | 'batches'>,
): Promise<{ rowCount: number; bytesWritten: number }> {
  try {
    const first = await stream.next();
    return await writeExportFile({
      ...opts,
      columns: first.done ? [] : first.value.columns,
      batches: (async function* () {
        if (!first.done) yield first.value.rows;
        for await (const batch of stream) yield batch.rows;
      })(),
    });
  } finally {
    await stream.return(undefined).catch(() => {});
  }
}
