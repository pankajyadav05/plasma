import { chmod, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ColumnMeta } from '@shared/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ExportCancelledError,
  ExportFileError,
  writeExportFile,
  writeExportFromQueryStream,
  writeExportRows,
} from './export-file';

const columns: ColumnMeta[] = [{ name: 'n', dataTypeID: 23, dataTypeName: 'int4' }];
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plasma-export-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('writeExportRows (C30)', () => {
  it('reports progress after every batch', async () => {
    const seen: number[] = [];
    const rows = Array.from({ length: 5 }, (_, i) => [i]);
    const res = await writeExportRows({
      filePath: join(dir, 'a.csv'),
      format: 'csv',
      columns,
      rows,
      batchSize: 2,
      onProgress: (p) => seen.push(p.rowCount),
    });
    expect(seen).toEqual([2, 4, 5]);
    expect(res.rowCount).toBe(5);
  });

  it('honours the CSV dialect', async () => {
    const file = join(dir, 'b.csv');
    await writeExportRows({
      filePath: file,
      format: 'csv',
      columns,
      rows: [[1]],
      csv: { delimiter: ';', header: false, quote: '"', nullAs: 'empty', lineEnding: 'lf' },
    });
    expect(await readFile(file, 'utf8')).toBe('﻿1\n');
  });

  it('cancelling removes the partial file and never creates the destination', async () => {
    let cancelled = false;
    const file = join(dir, 'c.csv');
    await expect(
      writeExportFile({
        filePath: file,
        format: 'csv',
        columns,
        isCancelled: () => cancelled,
        onProgress: () => {
          cancelled = true;
        },
        batches: (async function* () {
          yield [[1]];
          yield [[2]];
        })(),
      }),
    ).rejects.toBeInstanceOf(ExportCancelledError);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('write failures (P0-1)', () => {
  it('an unwritable destination rejects cleanly instead of crashing the process', async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    try {
      await expect(
        writeExportRows({
          filePath: join(dir, 'missing-dir', 'x.csv'),
          format: 'csv',
          columns,
          rows: [[1], [2]],
        }),
      ).rejects.toBeInstanceOf(ExportFileError);
      // Give a stray 'error' event the chance to surface.
      await new Promise((r) => setTimeout(r, 25));
    } finally {
      process.off('uncaughtException', onUncaught);
    }
    expect(uncaught).toEqual([]);
  });

  it('a read-only directory reports the file error and leaves nothing behind', async () => {
    const ro = join(dir, 'ro');
    await mkdir(ro);
    await chmod(ro, 0o500);
    try {
      const err = await writeExportRows({
        filePath: join(ro, 'x.csv'),
        format: 'csv',
        columns,
        rows: [[1]],
      }).catch((e: unknown) => e);
      // Root ignores directory modes; only assert when the OS enforced it.
      if (err instanceof Error) {
        expect(err).toBeInstanceOf(ExportFileError);
        expect(err.message).toMatch(/Could not write the export file/);
      }
    } finally {
      await chmod(ro, 0o700);
    }
    expect(await readdir(ro)).toEqual([]);
  });
});

describe('writeExportFromQueryStream (P1-3)', () => {
  function stream(onClose: () => void) {
    return (async function* () {
      try {
        yield { columns, rows: [[1], [2]] };
        yield { columns, rows: [[3]] };
      } finally {
        onClose();
      }
    })();
  }

  it('closes the cursor stream when the first write fails', async () => {
    let closed = false;
    await expect(
      writeExportFromQueryStream(
        stream(() => {
          closed = true;
        }),
        { filePath: join(dir, 'nope', 'z.csv'), format: 'csv' },
      ),
    ).rejects.toBeInstanceOf(ExportFileError);
    expect(closed).toBe(true);
  });

  it('closes the cursor stream when cancelled at the first check', async () => {
    let closed = false;
    await expect(
      writeExportFromQueryStream(
        stream(() => {
          closed = true;
        }),
        { filePath: join(dir, 'c2.csv'), format: 'csv', isCancelled: () => true },
      ),
    ).rejects.toBeInstanceOf(ExportCancelledError);
    expect(closed).toBe(true);
    expect(await readdir(dir)).toEqual([]);
  });

  it('writes everything and closes on success', async () => {
    let closed = false;
    const res = await writeExportFromQueryStream(
      stream(() => {
        closed = true;
      }),
      {
        filePath: join(dir, 'ok.csv'),
        format: 'csv',
        csv: { delimiter: ',', header: false, quote: '"', nullAs: 'empty', lineEnding: 'lf' },
      },
    );
    expect(res.rowCount).toBe(3);
    expect(closed).toBe(true);
    expect(await readFile(join(dir, 'ok.csv'), 'utf8')).toBe('﻿1\n2\n3\n');
  });
});
