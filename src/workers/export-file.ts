import { createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import {
  type ExportFormat,
  createExportStreamer,
} from "@shared/export-format";
import type { ColumnMeta } from "@shared/protocol";

async function writeChunk(
  stream: ReturnType<typeof createWriteStream>,
  chunk: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Stream formatted rows to a file path. Never retains the full document
 * string — each batch is written and released (U16).
 */
export async function writeExportFile(opts: {
  filePath: string;
  format: ExportFormat;
  columns: readonly ColumnMeta[];
  batches: AsyncIterable<readonly unknown[][]>;
}): Promise<{ rowCount: number; bytesWritten: number }> {
  const stream = createWriteStream(opts.filePath, { encoding: "utf8" });
  let bytesWritten = 0;
  let rowCount = 0;
  let pending: Promise<void> = Promise.resolve();

  const sink = (chunk: string) => {
    bytesWritten += Buffer.byteLength(chunk, "utf8");
    pending = pending.then(() => writeChunk(stream, chunk));
  };

  const streamer = createExportStreamer(opts.format, opts.columns, sink);
  try {
    streamer.begin();
    await pending;

    for await (const batch of opts.batches) {
      streamer.writeRows(batch as unknown[][]);
      rowCount += batch.length;
      await pending;
    }

    streamer.end();
    await pending;
    stream.end();
    await finished(stream);
  } catch (err) {
    stream.destroy();
    throw err;
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
  });
}
