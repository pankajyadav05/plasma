import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { activeTab, useSession } from '@/stores/session';
import { MigrationCheckPanel } from './MigrationCheckPanel';
import { useMigrationDialog } from './migration-dialog-store';

/** Lints the active SQL tab's whole script. Mounted once in the app shell. */
export function MigrationCheckDialog() {
  const open = useMigrationDialog((s) => s.open);
  const close = useMigrationDialog((s) => s.close);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      {open && <Body />}
    </Dialog>
  );
}

function Body() {
  const sql = useSession((s) => {
    const t = activeTab(s);
    return t?.kind === 'sql' ? t.sql : '';
  });
  return (
    <DialogContent className="max-w-[760px]" data-testid="migration-check-dialog">
      <DialogHeader>
        <DialogTitle>Check migration</DialogTitle>
        <DialogDescription>
          Lock levels and unsafe-DDL findings for the whole script in the editor. Nothing is run.
        </DialogDescription>
      </DialogHeader>
      <div className="max-h-[60vh] overflow-auto">
        <MigrationCheckPanel sql={sql} showClean />
      </div>
    </DialogContent>
  );
}
