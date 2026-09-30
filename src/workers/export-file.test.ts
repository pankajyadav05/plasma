import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ColumnMeta } from '@shared/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExportCancelledError, writeExportFile, writeExportRows } from './export-file';

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
