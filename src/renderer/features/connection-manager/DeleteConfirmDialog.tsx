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
import { Trash2 } from 'lucide-react';

/**
 * Confirmation dialog before deleting a saved connection.
 */
export function DeleteConfirmDialog() {
  const id = useSession((s) => s.deleteConfirmConnectionId);
  const savedConnections = useSession((s) => s.savedConnections);
  const requestDelete = useSession((s) => s.requestDeleteConnection);
  const deleteSaved = useSession((s) => s.deleteSaved);

  const entry = id ? savedConnections.find((c) => c.id === id) : null;
  const open = Boolean(id && entry);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && requestDelete(null)}>
      <DialogContent className="max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Delete connection?</DialogTitle>
          <DialogDescription>
            {entry && (
              <>
                <span className="font-medium text-foreground">{entry.name}</span>
                {' — '}
                {entry.host}:{entry.port}/{entry.database}
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="text-sm text-muted-foreground">
          The encrypted password will be removed from the local vault. This cannot be undone.
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => requestDelete(null)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => id && void deleteSaved(id)}>
            <Trash2 />
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
