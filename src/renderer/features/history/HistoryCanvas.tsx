import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { formatDuration } from '@/lib/format';
import { kbd } from '@/lib/platform';
import { useSession } from '@/stores/session';
import { Trash2, X } from 'lucide-react';
import { useState } from 'react';

/**
 * Full-window history view. Lists user-written queries (internal
 * Plasma plumbing — introspection, RLS, count, table data — is
 * filtered out at the IPC layer so the list stays meaningful).
 */
export function HistoryCanvas() {
  const history = useSession((s) => s.history);
  const clearHistory = useSession((s) => s.clearHistory);
  const reuseHistoryQuery = useSession((s) => s.reuseHistoryQuery);
  const setCanvasMode = useSession((s) => s.setCanvasMode);

  const [confirmClear, setConfirmClear] = useState(false);

  const reuse = (sql: string) => {
    reuseHistoryQuery(sql);
    setCanvasMode('sql');
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[880px] px-6 py-10">
          <header className="mb-6 flex items-start justify-between border-b border-border pb-4">
            <div>
              <h1 className="font-display text-2xl italic text-foreground">Query history</h1>
              <p className="font-display text-sm italic text-muted-foreground">
                {history.length.toLocaleString()} {history.length === 1 ? 'query' : 'queries'}{' '}
                you've run — click to reuse.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmClear(true)}
                disabled={history.length === 0}
              >
                <Trash2 />
                Clear
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setCanvasMode('database')}
                aria-label="Close history"
                title={`Close (${kbd('Esc')})`}
              >
                <X />
              </Button>
            </div>
          </header>

          {history.length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-10 text-center">
              <p className="font-display text-base italic text-muted-foreground">
                no history yet — run a query
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-1">
              {history.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => reuse(entry.sql)}
                    className="block w-full cursor-pointer rounded-md border border-transparent px-4 py-3 text-left transition-colors hover:border-border hover:bg-accent/40"
                  >
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>{new Date(entry.executedAt).toLocaleString()}</span>
                      {entry.error ? (
                        <span className="text-destructive">error</span>
                      ) : (
                        <>
                          {entry.rowCount !== null && (
                            <span>{entry.rowCount.toLocaleString()} rows</span>
                          )}
                          {entry.durationMs !== null && (
                            <span>{formatDuration(entry.durationMs)}</span>
                          )}
                        </>
                      )}
                    </div>
                    <pre className="mt-1 max-h-24 overflow-hidden whitespace-pre-wrap break-words font-mono text-xs text-foreground">
                      {entry.sql.slice(0, 800)}
                      {entry.sql.length > 800 ? '…' : ''}
                    </pre>
                    {entry.error && (
                      <div className="mt-1 font-mono text-xs text-destructive">{entry.error}</div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="Clear all query history?"
        description={`${history.length.toLocaleString()} ${history.length === 1 ? 'entry' : 'entries'} will be removed from the local store. This cannot be undone.`}
        confirmLabel="Clear history"
        onConfirm={() => void clearHistory()}
      />
    </div>
  );
}
