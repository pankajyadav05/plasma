import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { kbd } from '@/lib/platform';
import { useSession } from '@/stores/session';
import { Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { HistoryBrowser } from './HistoryBrowser';

/**
 * Full-window history view with server-side search + facets (U35).
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
      <div className="mx-auto flex min-h-0 w-full max-w-[960px] flex-1 flex-col px-6 py-10">
        <header className="mb-4 flex shrink-0 items-start justify-between border-b border-border pb-4">
          <div>
            <h1 className="font-display text-2xl italic text-foreground">Query history</h1>
            <p className="font-display text-sm italic text-muted-foreground">
              Search and filter what you've run — click to reuse, bookmark to save as a snippet.
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

        <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-border">
          <HistoryBrowser onReuse={reuse} />
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
