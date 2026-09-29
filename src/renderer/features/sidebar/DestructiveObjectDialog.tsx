import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useEffect, useState } from 'react';

export interface DestructiveRequest {
  /** "Truncate" or "Drop". */
  verb: string;
  /** What is affected, e.g. `table public.users`. */
  target: string;
  /** Builds the statement for the chosen options. */
  build: (opts: { cascade: boolean }) => string;
  /** Truncate only: explain that rows are removed, not the object. */
  detail?: string;
}

/**
 * Confirmation for sidebar Truncate… / Drop… (PC3). Shows the exact
 * statement, offers CASCADE, and hands the SQL back on confirm; the
 * caller runs it through the normal query path so the prod-tag gate
 * and read-only session still apply.
 */
export function DestructiveObjectDialog({
  request,
  onCancel,
  onConfirm,
}: {
  request: DestructiveRequest | null;
  onCancel: () => void;
  onConfirm: (sql: string) => void;
}) {
  const [cascade, setCascade] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset per request
  useEffect(() => setCascade(false), [request]);
  const sql = request ? request.build({ cascade }) : '';

  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-[460px]" data-testid="sidebar-destructive-dialog">
        <DialogHeader>
          <DialogTitle>
            {request?.verb} {request?.target}?
          </DialogTitle>
          <DialogDescription>{request?.detail ?? 'This cannot be undone.'}</DialogDescription>
        </DialogHeader>
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-[6px] bg-[var(--wb-field)] px-2.5 py-2 font-mono text-[12px] text-[var(--wb-text)]">
          {sql}
        </pre>
        <label
          htmlFor="sidebar-destructive-cascade"
          className="flex cursor-pointer items-center gap-2 text-[13px] text-[var(--wb-text)]"
        >
          <Checkbox
            id="sidebar-destructive-cascade"
            checked={cascade}
            onCheckedChange={(v) => setCascade(Boolean(v))}
          />
          <span>Cascade to dependent objects</span>
        </label>
        <DialogFooter>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => onConfirm(sql)}>
            {request?.verb}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
