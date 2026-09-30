import { describe, expect, it } from 'vitest';
import { type ExportJob, applyExportProgress, describeExportProgress } from './export-job';

const job: ExportJob = {
  jobId: 'a',
  format: 'csv',
  rowCount: 0,
  bytesWritten: 0,
  cancelling: false,
};

describe('export job progress', () => {
  it('updates the matching job and ignores others', () => {
    expect(
      applyExportProgress(job, { jobId: 'a', rowCount: 500, bytesWritten: 2048 }),
    ).toMatchObject({
      rowCount: 500,
      bytesWritten: 2048,
    });
    expect(applyExportProgress(job, { jobId: 'b', rowCount: 9, bytesWritten: 9 })).toBe(job);
    expect(applyExportProgress(null, { jobId: 'a', rowCount: 1, bytesWritten: 1 })).toBeNull();
  });
  it('describes rows and size', () => {
    expect(describeExportProgress({ rowCount: 1, bytesWritten: 0 })).toBe('1 row');
    expect(describeExportProgress({ rowCount: 1204, bytesWritten: 3.2 * 1024 * 1024 })).toBe(
      '1,204 rows · 3.2 MB',
    );
    expect(describeExportProgress({ rowCount: 10, bytesWritten: 100 })).toBe('10 rows · 1 KB');
  });
});
