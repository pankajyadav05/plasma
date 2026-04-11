import { Columns3, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useActiveTab, useSession } from "@/stores/session";
import { cn } from "@/lib/cn";

export function ColumnsPopover() {
  const tab = useActiveTab();
  const schema = useSession((s) => s.schema);
  const toggleColumnHidden = useSession((s) => s.toggleColumnHidden);
  const showAllColumns = useSession((s) => s.showAllColumns);

  if (!tab || tab.kind !== "table" || !tab.tableSchema || !tab.tableName) return null;

  const allColumns =
    schema?.columns
      .filter((c) => c.schema === tab.tableSchema && c.table === tab.tableName)
      .sort((a, b) => a.ordinal - b.ordinal) ?? [];

  const hiddenCount = tab.hiddenColumns.size;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant={hiddenCount > 0 ? "outline" : "ghost"}
          size="xs"
          className={hiddenCount > 0 ? "border-accent text-accent" : ""}
        >
          <Columns3 />
          Columns
          {hiddenCount > 0 && (
            <span className="rounded-sm bg-accent px-1 text-xs leading-none py-0.5 text-paper">
              {allColumns.length - hiddenCount}/{allColumns.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" className="w-96 p-0">
        <div className="flex items-center justify-between border-b border-border-soft px-4 py-3">
          <h3 className="font-mono text-xs uppercase text-ink-muted" style={{ letterSpacing: "0.10em" }}>
            Columns ({allColumns.length - hiddenCount} visible)
          </h3>
          {hiddenCount > 0 && (
            <Button variant="ghost" size="xs" onClick={() => void showAllColumns()} className="text-ink-muted">
              Show all
            </Button>
          )}
        </div>
        <div className="max-h-[400px] overflow-y-auto py-1">
          {allColumns.map((col) => {
            const hidden = tab.hiddenColumns.has(col.name);
            return (
              <button
                key={col.name}
                type="button"
                onClick={() => void toggleColumnHidden(col.name)}
                className={cn(
                  "flex w-full items-center gap-2.5 px-4 py-1.5 text-left font-mono text-sm transition-colors hover:bg-[var(--bg-hover)]",
                  hidden ? "text-ink-disabled" : "text-ink",
                )}
              >
                {hidden ? (
                  <EyeOff className="h-3.5 w-3.5 shrink-0 text-ink-disabled" />
                ) : (
                  <Eye className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
                )}
                <span className={cn("truncate font-semibold", hidden && "line-through")}>{col.name}</span>
                <span className="ml-auto shrink-0 font-mono text-xs text-ink-muted">{col.dataType}</span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
