import type { ExportProgress, ExportSaveRequest } from '@shared/protocol';
import { create } from 'zustand';

/**
 * The one export in flight (C30): drives the footer's progress indicator
 * and the Cancel button. Progress events arrive from the worker while the
 * `export.save` call is still pending.
 */
export interface ExportJob {
  jobId: string;
  format: ExportSaveRequest['format'];
  rowCount: number;
  bytesWritten: number;
  cancelling: boolean;
}

/** Fold a progress event into the job; events for other jobs are ignored. */
export function applyExportProgress(job: ExportJob | null, p: ExportProgress): ExportJob | null {
  if (!job || job.jobId !== p.jobId) return job;
  return { ...job, rowCount: p.rowCount, bytesWritten: p.bytesWritten };
}

/** "1,204 rows · 3.2 MB" */
export function describeExportProgress(job: Pick<ExportJob, 'rowCount' | 'bytesWritten'>): string {
  const rows = `${job.rowCount.toLocaleString()} ${job.rowCount === 1 ? 'row' : 'rows'}`;
  const b = job.bytesWritten;
  const size =
    b >= 1024 * 1024
      ? `${(b / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.max(1, Math.round(b / 1024))} KB`;
  return b > 0 ? `${rows} · ${size}` : rows;
}

interface ExportJobState {
  job: ExportJob | null;
  /** Save dialog → stream to file. Resolves when the export ends or is cancelled. */
  start(req: Omit<ExportSaveRequest, 'jobId'>): Promise<void>;
  cancel(): Promise<void>;
}

let off: (() => void) | null = null;

export const useExportJob = create<ExportJobState>((set, get) => ({
  job: null,

  async start(req) {
    if (get().job) return; // one export at a time
    const jobId = crypto.randomUUID();
    set({ job: { jobId, format: req.format, rowCount: 0, bytesWritten: 0, cancelling: false } });
    off?.();
    off = window.plasmaEvents?.on('plasma:export:progress', (...args: unknown[]) => {
      const p = args[args.length - 1] as ExportProgress | undefined;
      if (p && typeof p.jobId === 'string') set({ job: applyExportProgress(get().job, p) });
    });
    try {
      await window.plasma.export.save({ ...req, jobId });
    } catch (err) {
      console.error('[plasma] export failed', err);
    } finally {
      off?.();
      off = null;
      set({ job: null });
    }
  },

  async cancel() {
    const job = get().job;
    if (!job || job.cancelling) return;
    set({ job: { ...job, cancelling: true } });
    try {
      await window.plasma.export.cancel(job.jobId);
    } catch (err) {
      console.error('[plasma] export cancel failed', err);
    }
  },
}));
