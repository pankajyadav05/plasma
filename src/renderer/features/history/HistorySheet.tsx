import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { formatDuration } from '@/lib/format';
import { useSession } from '@/stores/session';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';

export function HistorySheet() {
  const open = useSession((s) => s.historyOpen);
  const setOpen = useSession((s) => s.setHistoryOpen);
  const history = useSession((s) => s.history);
  const clearHistory = useSession((s) => s.clearHistory);
  const reuseHistoryQuery = useSession((s) => s.reuseHistoryQuery);
  const [confirmClear, setConfirmClear] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="right" className="w-full sm:max-w-xl">
        <SheetHeader className="flex flex-row items-start justify-between gap-3 pr-10">
          <div>
            <SheetTitle>Query history</SheetTitle>
            <SheetDescription>
              Last {history.length.toLocaleString()} queries — click to reuse.
            </SheetDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmClear(true)}
            disabled={history.length === 0}
          >
            <Trash2 />
            Clear
          </Button>
        </SheetHeader>
        <ConfirmDialog
          open={confirmClear}
          onOpenChange={setConfirmClear}
          title="Clear all query history?"
          description={`${history.length.toLocaleString()} ${history.length === 1 ? 'entry' : 'entries'} will be removed from the local store. This cannot be undone.`}
          confirmLabel="Clear history"
          onConfirm={() => void clearHistory()}
        />

        <div className="-mx-6 min-h-0 flex-1 overflow-y-auto">
          {history.length === 0 && (
            <div className="flex h-full items-center justify-center font-display text-base italic text-muted-foreground">
              no history yet — run a query
            </div>
          )}
          {history.map((entry) => (
            <button
              type="button"
              key={entry.id}
              onClick={() => reuseHistoryQuery(entry.sql)}
              className="block w-full cursor-pointer border-b px-6 py-3 text-left transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none"
            >
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span>{new Date(entry.executedAt).toLocaleString()}</span>
                {entry.error ? (
                  <span className="text-destructive">error</span>
                ) : (
                  <>
                    {entry.rowCount !== null && <span>{entry.rowCount.toLocaleString()} rows</span>}
                    {entry.durationMs !== null && <span>{formatDuration(entry.durationMs)}</span>}
                  </>
                )}
              </div>
              <pre className="mt-1 max-h-24 overflow-hidden whitespace-pre-wrap break-words font-mono text-xs text-foreground">
                {entry.sql.slice(0, 400)}
                {entry.sql.length > 400 ? '…' : ''}
              </pre>
              {entry.error && (
                <div className="mt-1 font-mono text-xs text-destructive">{entry.error}</div>
              )}
            </button>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
