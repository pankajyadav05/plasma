import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Pill } from '@/components/ui/workbench';
import { cleanIpcError } from '@/lib/errors';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import { Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

/** Graphite search-field look for dialog inputs (--wb-field, 26px, radius 6). */
const FIELD_CLASS =
  'h-[26px] rounded-[6px] border-0 bg-[var(--wb-field)] px-2 font-mono text-[13px] text-[var(--wb-text)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--wb-text)_12%,transparent)] placeholder:text-[var(--wb-text-3)] focus-visible:ring-0 focus-visible:shadow-[0_0_0_2px_color-mix(in_srgb,var(--wb-accent)_55%,transparent)]';

/**
 * Type-to-confirm delete for OpenSearch indices. The user must type the
 * exact index name — OpenSearch deletes are not reversible (no built-in
 * snapshot before drop), so the friction here is intentional.
 */
export function DeleteIndexDialog() {
  const name = useSession((s) => s.osDeleteIndexName);
  const requestDelete = useSession((s) => s.requestOsDeleteIndex);
  const refreshOverview = useSession((s) => s.refreshOsOverview);

  const [confirmText, setConfirmText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (name) {
      setConfirmText('');
      setError(null);
    }
  }, [name]);

  if (!name) return null;
  const open = true;
  const matches = confirmText === name;

  async function onDelete() {
    if (!name || !matches) return;
    setSubmitting(true);
    setError(null);
    try {
      await ipc.os.deleteIndex(name);
      await refreshOverview();
      requestDelete(null);
    } catch (err) {
      setError(cleanIpcError(err instanceof Error ? err.message : String(err)));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !submitting && requestDelete(null)}>
      <DialogContent className="max-w-[440px] gap-3 rounded-[10px] border-[var(--wb-separator)] bg-[var(--wb-content)] p-5 text-[13px] text-[var(--wb-text)]">
        <DialogHeader className="space-y-1">
          <DialogTitle className="font-sans text-[15px] font-semibold not-italic leading-tight tracking-normal">
            Delete index?
          </DialogTitle>
          <DialogDescription className="font-sans text-[13px] not-italic leading-snug text-[var(--wb-text-2)]">
            All documents in <span className="font-mono text-[var(--wb-text)]">{name}</span> will be
            permanently removed. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void onDelete();
          }}
        >
          <label htmlFor="os-delete-confirm" className="text-[12px] text-[var(--wb-text-2)]">
            Type <span className="font-mono text-[var(--wb-text)]">{name}</span> to confirm
          </label>
          <Input
            id="os-delete-confirm"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            className={FIELD_CLASS}
            autoComplete="off"
            spellCheck={false}
            autoFocus
          />
          {error && (
            <div className="rounded-[6px] bg-[color-mix(in_srgb,var(--destructive)_14%,transparent)] px-2.5 py-2 font-mono text-[12px] leading-snug text-[var(--wb-text)]">
              {error
                .replace(/^Error invoking remote method '[^']+':\s*/i, '')
                .replace(/^Error:\s*/i, '')}
            </div>
          )}
        </form>
        <DialogFooter className="gap-2 pt-1 sm:space-x-0">
          <Pill className="h-7 px-3" onClick={() => requestDelete(null)} disabled={submitting}>
            Cancel
          </Pill>
          <Button
            variant="destructive"
            className="h-7 gap-1.5 rounded-[6px] px-3 text-[13px] font-normal [&_svg]:h-3.5 [&_svg]:w-3.5"
            onClick={() => void onDelete()}
            disabled={!matches || submitting}
          >
            <Trash2 />
            {submitting ? 'Deleting…' : 'Delete index'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
