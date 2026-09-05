import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useSession } from '@/stores/session';
import { Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { HistoryBrowser } from './HistoryBrowser';

export function HistorySheet() {
  const open = useSession((s) => s.historyOpen);
  const setOpen = useSession((s) => s.setHistoryOpen);
  const history = useSession((s) => s.history);
  const clearHistory = useSession((s) => s.clearHistory);
  const reuseHistoryQuery = useSession((s) => s.reuseHistoryQuery);
  const loadHistory = useSession((s) => s.loadHistory);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    if (open) void loadHistory();
  }, [open, loadHistory]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="right" className="flex w-full flex-col sm:max-w-xl">
        <SheetHeader className="flex flex-row items-start justify-between gap-3 pr-10">
          <div>
            <SheetTitle>Query history</SheetTitle>
            <SheetDescription>
              Per-connection search and facets — click to reuse, bookmark to save as snippet.
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

        <HistoryBrowser
          compact
          onReuse={(sql) => {
            reuseHistoryQuery(sql);
          }}
        />
      </SheetContent>
    </Sheet>
  );
}
