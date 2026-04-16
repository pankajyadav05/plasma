import { ChevronLeft, ChevronRight, Play, RefreshCw, Sparkles, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { kbd } from "@/lib/platform";
import { useActiveTab, useSession } from "@/stores/session";
import { MonacoEditor } from "./MonacoEditor";

const COLLAPSED_WIDTH = 40;
const EXPANDED_WIDTH = 520;

/**
 * Right-side editor panel. Two modes:
 *
 *   SQL tab:   editable Monaco, Run / Cancel buttons
 *   Table tab: read-only Monaco showing the compiled SQL, Refresh button
 *
 * Collapsed: 40px vertical strip. Expanded: 520px panel.
 */
export function EditorPane() {
  const tab = useActiveTab();
  const setSql = useSession((s) => s.setSql);
  const runQuery = useSession((s) => s.runQuery);
  const cancelQuery = useSession((s) => s.cancelQuery);
  const refreshTable = useSession((s) => s.refreshTable);
  const connectionState = useSession((s) => s.connectionState);
  const expanded = useSession((s) => s.editorExpanded);
  const toggle = useSession((s) => s.toggleEditor);
  const theme = useSession((s) => s.settings.theme);
  const fontSize = useSession((s) => s.settings.editorFontSize);
  const claudeApiKey = useSession((s) => s.settings.claudeApiKey);

  if (!tab) return null;

  const isTable = tab.kind === "table";
  const canRun = connectionState === "connected" && (isTable || tab.sql.trim().length > 0);
  const running = tab.queryRunState === "running";

  const handleAction = () => {
    if (running) {
      void cancelQuery();
    } else if (isTable) {
      void refreshTable();
    } else {
      void runQuery();
    }
  };

  return (
    <section
      className="flex shrink-0 flex-col overflow-hidden border-l bg-background transition-[width] duration-base ease-out"
      style={{ width: expanded ? EXPANDED_WIDTH : COLLAPSED_WIDTH }}
      aria-label="Query editor"
    >
      {expanded ? (
        <>
          {/* ── Header bar ── */}
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background pl-2 pr-3">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggle}
              aria-label="Collapse editor"
              title={`Collapse (${kbd("J")} · Esc)`}
            >
              <ChevronRight />
            </Button>

            <span className="text-sm font-medium text-foreground">{tab.title}</span>
            {isTable && (
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs uppercase text-muted-foreground">
                table
              </span>
            )}

            <div className="flex-1" />

            {/* Ask AI pill — only for SQL tabs, and only once a Claude key is set */}
            {!isTable && claudeApiKey.trim().length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="font-display italic text-muted-foreground"
                title="Ask Claude to write or explain SQL"
              >
                <Sparkles className="h-3.5 w-3.5 text-primary" />
                ask
              </Button>
            )}

            {/* Action button — Run / Cancel / Refresh */}
            {running ? (
              <Button variant="destructive" size="sm" onClick={handleAction}>
                <Square className="fill-current" />
                Cancel
                <Kbd className="border-0 bg-transparent text-destructive-foreground/80">{kbd(".")}</Kbd>
              </Button>
            ) : isTable ? (
              <Button variant="secondary" size="sm" onClick={handleAction} disabled={!canRun}>
                <RefreshCw />
                Refresh
              </Button>
            ) : (
              <Button variant="primary" size="sm" onClick={handleAction} disabled={!canRun}>
                <Play className="fill-current" />
                Run
                <Kbd className="border-0 bg-transparent text-primary-foreground/80">{kbd("⏎")}</Kbd>
              </Button>
            )}
          </div>

          {/* ── Monaco editor body ── */}
          <div className="relative min-h-0 flex-1 pt-4 overflow-hidden">
            {isTable && (
              <div className="absolute left-4 top-2 z-10 font-display text-xs italic text-muted-foreground">
                compiled from table browser — read-only
              </div>
            )}
            <MonacoEditor
              value={tab.sql}
              onChange={isTable ? () => {} : setSql}
              onRun={() => {
                if (isTable) void refreshTable();
                else void runQuery();
              }}
              onToggle={toggle}
              theme={theme}
              fontSize={fontSize}
              readOnly={isTable}
            />
          </div>
        </>
      ) : (
        /* ── Collapsed: narrow vertical strip ── */
        <button
          type="button"
          onClick={toggle}
          aria-label="Expand editor"
          title={`Expand editor (${kbd("J")}) — ${tab.title}`}
          className="group flex h-full w-full cursor-pointer flex-col items-center gap-4 border-0 bg-background pb-4 pt-4 text-muted-foreground transition-colors hover:bg-[var(--bg-hover)] hover:text-primary"
        >
          <ChevronLeft className="h-4 w-4 shrink-0" />
          {running && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-none bg-primary" />}
          <span
            className="flex-1 font-mono text-sm text-muted-foreground group-hover:text-foreground"
            style={{
              writingMode: "vertical-rl",
              transform: "rotate(180deg)",
              letterSpacing: "0.02em",
            }}
          >
            {tab.title}
          </span>
          <span
            className="shrink-0 font-mono text-xs text-muted-foreground"
            style={{ writingMode: "vertical-rl", letterSpacing: "0.08em" }}
          >
            {kbd("J")}
          </span>
        </button>
      )}
    </section>
  );
}
