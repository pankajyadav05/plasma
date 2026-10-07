import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { type EditConflict, canKeepMine } from '@/lib/edit-conflicts';
import { useSession } from '@/stores/session';

/**
 * Review of rows that changed on the server between loading the grid and
 * committing. Nothing was saved; every staged edit is still there. Per row:
 * the value the grid loaded (original), the server's value now (theirs) and
 * the user's (yours), with "Keep mine" (re-stage on the new values) and
 * "Take theirs" (drop my change). Closing leaves everything staged.
 */
export function EditConflictDialog() {
  const review = useSession((s) => s.editConflicts);
  const open = useSession((s) => s.editConflictsOpen);
  const resolve = useSession((s) => s.resolveEditConflict);
  const close = useSession((s) => s.closeEditConflicts);
  const items = review?.items ?? [];

  return (
    <Dialog
      open={open && items.length > 0}
      onOpenChange={(o) => {
        if (!o) close();
      }}
    >
      <DialogContent className="max-w-[720px]">
        <DialogHeader>
          <DialogTitle>
            {items.length === 1
              ? 'A row changed while you were editing'
              : 'Rows changed while you were editing'}
          </DialogTitle>
          <DialogDescription>
            Nothing was saved. Your changes are still staged. For each row, keep your change on top
            of the new values, or take what is on the server and drop your change.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[52vh] space-y-3 overflow-auto pr-1">
          {items.map((item) => (
            <ConflictRow key={item.id} item={item} onResolve={(c) => resolve(item.id, c)} />
          ))}
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={() => close()}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function headline(item: EditConflict): string {
  const what = `${item.schema}.${item.table} · ${item.rowLabel}`;
  switch (item.kind) {
    case 'changed':
      return `${what} was changed by someone else`;
    case 'gone':
      return `${what} no longer exists`;
    case 'duplicate':
      return `A new row in ${item.schema}.${item.table} uses a key that already exists`;
    default:
      return `${what} could not be compared (the current row could not be read)`;
  }
}

function ConflictRow({
  item,
  onResolve,
}: {
  item: EditConflict;
  onResolve: (choice: 'mine' | 'theirs') => void;
}) {
  const keepable = canKeepMine(item);
  const dropLabel =
    item.kind === 'changed' || item.kind === 'unknown' ? 'Take theirs' : 'Drop my change';
  return (
    <section
      aria-label={headline(item)}
      className="rounded-[8px] border border-[var(--wb-separator)] bg-[var(--wb-control)] p-3"
    >
      <h3 className="text-[12.5px] font-semibold text-[var(--wb-text)]">{headline(item)}</h3>
      {item.columns.length > 0 && (
        <table className="mt-2 w-full table-fixed font-mono text-[12px]">
          <thead>
            <tr className="text-left font-sans text-[11.5px] text-[var(--wb-text-2)]">
              <th className="w-[22%] py-1 pr-2 font-medium">Column</th>
              <th className="py-1 pr-2 font-medium">Original</th>
              <th className="py-1 pr-2 font-medium">Theirs (now)</th>
              <th className="py-1 font-medium">Yours</th>
            </tr>
          </thead>
          <tbody>
            {item.columns.map((c) => (
              <tr key={c.column} className="border-t border-[var(--wb-separator)] align-top">
                <td className="break-words py-1 pr-2 font-sans text-[var(--wb-text-2)]">
                  {c.column}
                </td>
                <td className="break-words py-1 pr-2 text-[var(--wb-text-3)]">
                  {show(c.original)}
                </td>
                <td
                  className={
                    c.changedByOther
                      ? 'break-words py-1 pr-2 font-semibold text-[var(--wb-text)]'
                      : 'break-words py-1 pr-2 text-[var(--wb-text-2)]'
                  }
                >
                  {item.kind === 'changed' ? show(c.theirs) : '—'}
                </td>
                <td className="break-words py-1 text-[var(--wb-text)]">
                  {c.mine === undefined ? 'delete row' : show(c.mine)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {item.kind === 'changed' && item.columns.every((c) => !c.changedByOther) && (
        <p className="mt-2 text-[12px] text-[var(--wb-text-2)]">
          The values look the same as before. Something Plasma cannot show (or a different spelling
          of the same value) changed. Keeping yours stops comparing this row.
        </p>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="secondary" onClick={() => onResolve('theirs')}>
          {dropLabel}
        </Button>
        {keepable && (
          <Button variant="primary" onClick={() => onResolve('mine')}>
            Keep mine
          </Button>
        )}
      </div>
    </section>
  );
}

function show(v: string | null | undefined): string {
  if (v === undefined) return '—';
  if (v === null) return 'NULL';
  return v.length > 200 ? `${v.slice(0, 200)}…` : v;
}
