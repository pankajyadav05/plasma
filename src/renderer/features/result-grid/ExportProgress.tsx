import { Pill } from '@/components/ui/workbench';
import { describeExportProgress, useExportJob } from '@/stores/export-job';
import { Loader2, X } from 'lucide-react';

/** C30: shows the running export (rows / size so far) with a Cancel button. */
export function ExportProgress() {
  const job = useExportJob((s) => s.job);
  const cancel = useExportJob((s) => s.cancel);
  if (!job) return null;
  return (
    <output
      className="flex shrink-0 items-center gap-1.5 text-[12px] text-[var(--wb-text-2)]"
      aria-live="polite"
      data-testid="export-progress"
    >
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      <span className="tabular-nums">
        {job.cancelling
          ? 'Cancelling export…'
          : `Exporting ${job.format.toUpperCase()} · ${describeExportProgress(job)}`}
      </span>
      <Pill onClick={() => void cancel()} disabled={job.cancelling} title="Cancel the export">
        <X />
        Cancel
      </Pill>
    </output>
  );
}
