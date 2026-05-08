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
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import { Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

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
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !submitting && requestDelete(null)}>
      <DialogContent className="max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Delete index?</DialogTitle>
          <DialogDescription>
            All documents in <span className="font-mono text-foreground">{name}</span> will be
            permanently removed. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 text-sm">
          <span className="font-mono text-[11px] text-muted-foreground">
            Type <span className="text-foreground">{name}</span> to confirm:
          </span>
          <Input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            className="font-mono text-xs"
            autoFocus
          />
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 font-mono text-[11px] leading-snug text-foreground">
              {error
                .replace(/^Error invoking remote method '[^']+':\s*/i, '')
                .replace(/^Error:\s*/i, '')}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => requestDelete(null)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="destructive"
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
