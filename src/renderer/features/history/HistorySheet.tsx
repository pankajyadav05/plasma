import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useSession } from "@/stores/session";

export function HistorySheet() {
  const open = useSession((s) => s.historyOpen);
  const setOpen = useSession((s) => s.setHistoryOpen);
  const history = useSession((s) => s.history);
  const clearHistory = useSession((s) => s.clearHistory);
  const reuseHistoryQuery = useSession((s) => s.reuseHistoryQuery);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="right" className="w-[640px] max-w-[90vw]">
        <SheetHeader className="flex items-start justify-between gap-3 pr-20">
          <div>
            <SheetTitle>Query history</SheetTitle>
            <SheetDescription>Last {history.length.toLocaleString()} queries — click to reuse.</SheetDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (window.confirm("Clear all query history?")) {
                void clearHistory();
              }
            }}
          >
            <Trash2 />
            Clear
          </Button>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {history.length === 0 && (
            <div className="flex h-full items-center justify-center font-display text-base italic text-ink-muted">
              no history yet — run a query
            </div>
          )}
          {history.map((entry) => (
            <button
              type="button"
              key={entry.id}
              onClick={() => reuseHistoryQuery(entry.sql)}
              className="block w-full cursor-pointer border-b border-border-soft px-8 py-4 text-left transition-colors hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)] focus-visible:outline-none"
            >
              <div className="flex items-center gap-3 font-mono text-xs uppercase text-ink-muted">
                <span>{new Date(entry.executedAt).toLocaleString()}</span>
                {entry.error ? (
                  <span className="text-accent">error</span>
                ) : (
                  <>
                    {entry.rowCount !== null && <span>{entry.rowCount.toLocaleString()} rows</span>}
                    {entry.durationMs !== null && <span>{entry.durationMs} ms</span>}
                  </>
                )}
              </div>
              <pre className="mt-1 max-h-24 overflow-hidden whitespace-pre-wrap break-words font-mono text-base text-ink">
                {entry.sql.slice(0, 400)}
                {entry.sql.length > 400 ? "…" : ""}
              </pre>
              {entry.error && <div className="mt-1 font-mono text-xs text-accent">{entry.error}</div>}
            </button>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
