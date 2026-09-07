import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useSession } from '@/stores/session';

/**
 * Shown when disconnect / connect is attempted while buffered cell edits
 * still exist (U01). Forces an explicit commit, discard, or cancel before
 * the connection switch proceeds.
 */
export function PendingEditsGateDialog() {
  const gate = useSession((s) => s.connectionActionGate);
  const edits = useSession((s) => s.pendingEdits);
  const busy = useSession((s) => s.pendingEditsBusy);
  const resolve = useSession((s) => s.resolveConnectionAction);
  const cancel = useSession((s) => s.cancelConnectionAction);

  const actionLabel =
    gate?.kind === 'disconnect'
      ? 'disconnect'
      : gate?.kind === 'connectSaved' || gate?.kind === 'connect'
        ? 'switch connections'
        : 'continue';

  return (
    <Dialog
      open={Boolean(gate)}
      onOpenChange={(o) => {
        if (!o && !busy) cancel();
      }}
    >
      <DialogContent className="max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Uncommitted edits</DialogTitle>
          <DialogDescription>
            You have{' '}
            <span className="font-semibold text-foreground">
              {edits.length} pending change{edits.length === 1 ? '' : 's'}
            </span>{' '}
            buffered against the current connection. Commit or discard them before you{' '}
            {actionLabel}.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" disabled={busy} onClick={() => cancel()}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void resolve('discard')}
          >
            Discard
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => void resolve('commit')}
          >
            {busy ? 'Committing…' : 'Commit'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
