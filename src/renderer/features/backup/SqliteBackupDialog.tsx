import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cleanIpcError } from '@/lib/errors';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import { useEffect, useState } from 'react';
import { formatBytes } from './admin-parts';

/**
 * "Export database file copy" for SQLite: main asks where to save, the worker
 * copies the open database with SQLite's online backup API (a consistent
 * snapshot, safe while the file is in use). pg_dump has no meaning here.
 */
export function SqliteBackupDialog({
  open,
  onOpenChange,
}: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const file = useSession((s) => s.activeConfig?.database ?? '');
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'running' }
    | { kind: 'done'; filePath: string; bytes: number }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  useEffect(() => {
    if (open) setState({ kind: 'idle' });
  }, [open]);

  const run = async () => {
    setState({ kind: 'running' });
    try {
      const done = await ipc.conn.sqliteBackupCopy();
      setState(done ? { kind: 'done', ...done } : { kind: 'idle' });
    } catch (err) {
      setState({
        kind: 'error',
        message: cleanIpcError(err instanceof Error ? err.message : String(err)),
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Export database file copy</DialogTitle>
          <DialogDescription>
            Writes a consistent copy of <span className="font-mono">{file}</span> to a new file. The
            database stays open and writable while it is copied.
          </DialogDescription>
        </DialogHeader>
        {state.kind === 'done' && (
          <output className="block text-[13px] text-[var(--wb-text)]">
            Saved {formatBytes(state.bytes)} to <span className="font-mono">{state.filePath}</span>.
          </output>
        )}
        {state.kind === 'error' && (
          <p className="text-[13px] text-destructive" role="alert">
            {state.message}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={() => void run()} disabled={state.kind === 'running'}>
            {state.kind === 'running' ? 'Copying…' : 'Choose file and copy…'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
