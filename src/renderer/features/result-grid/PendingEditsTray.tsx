import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useSession } from '@/stores/session';
import { Check, ChevronUp, Loader2, RotateCcw } from 'lucide-react';
import { useState } from 'react';

/**
 * Inline-edit pending-changes tray. Surfaces buffered cell edits so
 * users can review what's about to hit the database, jump to a row,
 * or revert before committing. Renders only when there's at least
 * one pending edit — keeps the UI quiet during normal browsing.
 *
 * Commits run inside a single transaction (BEGIN…COMMIT) so partial
 * failures roll back cleanly.
 */
export function PendingEditsTray() {
  const edits = useSession((s) => s.pendingEdits);
  const busy = useSession((s) => s.pendingEditsBusy);
  const commit = useSession((s) => s.commitPendingEdits);
  const revert = useSession((s) => s.revertPendingEdits);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (edits.length === 0) return null;

  const onCommit = async () => {
    setError(null);
    try {
      await commit();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-t border-primary/40 bg-primary/5 px-3 text-xs">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 font-display italic text-foreground hover:bg-primary/10"
          >
            <span className="rounded-sm bg-primary px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary-foreground">
              {edits.length}
            </span>
            pending change{edits.length === 1 ? '' : 's'}
            <ChevronUp className="h-3 w-3" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="top"
          sideOffset={6}
          className="w-[520px] max-w-[90vw] p-0"
        >
          <div className="border-b border-border px-3 py-2 font-display text-xs italic text-muted-foreground">
            Pending UPDATE statements (commits as one transaction)
          </div>
          <div className="max-h-[280px] overflow-auto">
            <table className="w-full font-mono text-[11px]">
              <thead className="sticky top-0 bg-background">
                <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-2 py-1.5">table</th>
                  <th className="px-2 py-1.5">pk</th>
                  <th className="px-2 py-1.5">column</th>
                  <th className="px-2 py-1.5">old → new</th>
                </tr>
              </thead>
              <tbody>
                {edits.map((e) => (
                  <tr key={e.id} className="border-b border-border/60">
                    <td className="px-2 py-1.5">
                      {e.schema}.{e.table}
                    </td>
                    <td className="px-2 py-1.5 text-muted-foreground">
                      {Object.entries(e.pkValues)
                        .map(([k, v]) => `${k}=${String(v)}`)
                        .join(', ')}
                    </td>
                    <td className="px-2 py-1.5">{e.column}</td>
                    <td className="px-2 py-1.5">
                      <span className="text-muted-foreground line-through">
                        {format(e.oldValue)}
                      </span>{' '}
                      <span className="text-primary">{format(e.newValue)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </PopoverContent>
      </Popover>

      <div className="flex-1" />

      {error && (
        <span className="font-mono text-destructive" title={error}>
          {error.length > 60 ? `${error.slice(0, 60)}…` : error}
        </span>
      )}

      <Button
        variant="ghost"
        size="xs"
        onClick={() => void revert()}
        disabled={busy}
        title="Discard pending changes"
      >
        <RotateCcw />
        Revert
      </Button>
      <Button
        variant="primary"
        size="xs"
        onClick={() => void onCommit()}
        disabled={busy}
        title="Commit pending changes (single transaction)"
      >
        {busy ? <Loader2 className="animate-spin" /> : <Check />}
        Commit {edits.length}
      </Button>
    </div>
  );
}

function format(v: unknown): string {
  if (v === null) return 'NULL';
  if (v === undefined) return '—';
  if (typeof v === 'string') return v.length > 30 ? `${v.slice(0, 30)}…` : v;
  return String(v);
}
