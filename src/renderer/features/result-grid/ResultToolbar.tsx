import { useEffect, useState } from "react";
import { Download, FileJson, FileText, FileType2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { exportResult } from "@/lib/export";
import { useActiveTab, useSession } from "@/stores/session";
import { FilterPopover } from "./FilterPopover";
import { ColumnsPopover } from "./ColumnsPopover";
import { SortPopover } from "./SortPopover";

/**
 * Toolbar above the result grid. Layout:
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ [Filter] [Columns]          [Export ▾] [↻]  1,242 ms    │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Filter & Columns are table-tab only (don't make sense for raw SQL).
 * Export, Refresh, and duration show whenever there's a rendered result.
 */
export function ResultToolbar() {
  const tab = useActiveTab();
  const refreshTable = useSession((s) => s.refreshTable);
  const runQuery = useSession((s) => s.runQuery);
  const [exportOpen, setExportOpen] = useState(false);

  // Listen for menu-driven export events so File → Export Results works
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ kind: "csv" | "json" }>).detail;
      const current = useSession.getState();
      const activeT = current.tabs.find((t) => t.id === current.activeTabId);
      if (!activeT?.queryResult) return;
      exportResult(activeT.queryResult, detail.kind, activeT.title.replace(/\.sql$/i, ""));
    };
    window.addEventListener("plasma:export", handler);
    return () => window.removeEventListener("plasma:export", handler);
  }, []);

  if (!tab) return null;

  const isTable = tab.kind === "table";
  const hasResult = Boolean(tab.queryResult && tab.queryResult.columns.length > 0) && !tab.queryError;
  const canRefresh = Boolean(tab.queryResult) || isTable;

  const doExport = (format: "csv" | "json" | "sql") => {
    if (!tab.queryResult) return;
    exportResult(tab.queryResult, format, tab.title.replace(/\.sql$/i, ""));
    setExportOpen(false);
  };

  const handleRefresh = () => {
    if (isTable) void refreshTable();
    else void runQuery();
  };

  // Don't render the toolbar at all for SQL tabs with nothing to act on
  if (!isTable && !hasResult && !canRefresh) return null;

  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border-soft bg-paper px-3">
      {/* ── Left cluster: Filter + Columns + Sort (table tabs only) ── */}
      {isTable && (
        <div className="flex items-center gap-1">
          <FilterPopover />
          <ColumnsPopover />
          <SortPopover />
        </div>
      )}

      <div className="flex-1" />

      {/* ── Right cluster: Export, Refresh, duration ── */}
      {hasResult && (
        <Popover open={exportOpen} onOpenChange={setExportOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="xs" title="Export results">
              <Download />
              Export
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" sideOffset={4} className="w-[180px] p-1">
            <ExportMenuItem
              icon={<FileText className="h-3.5 w-3.5 text-ink-muted" />}
              label="CSV"
              hint=".csv"
              onClick={() => doExport("csv")}
            />
            <ExportMenuItem
              icon={<FileJson className="h-3.5 w-3.5 text-ink-muted" />}
              label="JSON"
              hint=".json"
              onClick={() => doExport("json")}
            />
            <ExportMenuItem
              icon={<FileType2 className="h-3.5 w-3.5 text-ink-muted" />}
              label="SQL INSERT"
              hint=".sql"
              onClick={() => doExport("sql")}
            />
          </PopoverContent>
        </Popover>
      )}

      {canRefresh && (
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={handleRefresh}
          disabled={tab.queryRunState === "running"}
          aria-label="Refresh"
          title={isTable ? "Refresh (re-run query)" : "Re-run query"}
        >
          <RefreshCw className={tab.queryRunState === "running" ? "animate-spin" : ""} />
        </Button>
      )}

      {hasResult && tab.queryResult && (
        <>
          <Separator orientation="vertical" className="h-4" />
          <span className="font-mono tabular-nums text-sm text-ink-muted" title="Query duration">
            {tab.queryResult.durationMs.toLocaleString()} ms
          </span>
        </>
      )}
    </div>
  );
}

function ExportMenuItem({
  icon,
  label,
  hint,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left font-mono text-xs text-ink transition-colors hover:bg-[var(--bg-hover)]"
    >
      {icon}
      <span className="flex-1">{label}</span>
      <span className="text-xs text-ink-muted">{hint}</span>
    </button>
  );
}
