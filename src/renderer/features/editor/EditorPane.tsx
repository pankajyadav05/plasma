import { ChevronLeft, ChevronRight, Play, RefreshCw, Sparkles, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
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
      className="flex shrink-0 flex-col overflow-hidden border-l-2 border-border-strong bg-paper transition-[width] duration-base ease-out"
      style={{ width: expanded ? EXPANDED_WIDTH : COLLAPSED_WIDTH }}
      aria-label="Query editor"
    >
      {expanded ? (
        <>
          {/* ── Header bar ── */}
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border-soft bg-paper pl-2 pr-3">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggle}
              aria-label="Collapse editor"
              title="Collapse (⌘J · Esc)"
            >
              <ChevronRight />
            </Button>

            <span className="font-mono text-sm text-ink">{tab.title}</span>
            {isTable && (
              <span className="rounded-sm bg-paper-selected px-1.5 py-0.5 font-mono text-xs uppercase text-ink-muted">
                table
              </span>
            )}

            <div className="flex-1" />

            {/* Ask AI pill — only for SQL tabs */}
            {!isTable && (
              <Button
                variant="secondary"
                size="sm"
                className="h-7 gap-1.5 px-2.5 font-display text-sm italic normal-case tracking-normal text-ink-muted"
                title="AI integration — wiring pending"
              >
                <Sparkles className="h-3 w-3 text-accent" />
                ask
              </Button>
            )}

            {/* Action button — Run / Cancel / Refresh */}
            {running ? (
              <Button variant="destructive" size="sm" onClick={handleAction}>
                <Square />
                Cancel
                <Kbd>⌘.</Kbd>
              </Button>
            ) : isTable ? (
              <Button variant="secondary" size="sm" onClick={handleAction} disabled={!canRun}>
                <RefreshCw />
                Refresh
              </Button>
            ) : (
              <Button variant="primary" size="sm" onClick={handleAction} disabled={!canRun}>
                <Play className="fill-accent text-accent" />
                Run
                <Kbd className="border-0 bg-transparent text-paper/70">⌘⏎</Kbd>
              </Button>
            )}
          </div>

          {/* ── Monaco editor body ── */}
          <div className="relative min-h-0 flex-1 overflow-hidden">
            {isTable && (
              <div className="absolute left-4 top-2 z-10 font-display text-xs italic text-ink-muted">
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
          title={`Expand editor (⌘J) — ${tab.title}`}
          className="group flex h-full w-full cursor-pointer flex-col items-center gap-4 border-0 bg-paper pb-4 pt-4 text-ink-muted transition-colors hover:bg-[var(--bg-hover)] hover:text-accent"
        >
          <ChevronLeft className="h-4 w-4 shrink-0" />
          {running && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-none bg-accent" />}
          <span
            className="flex-1 font-mono text-sm text-ink-muted group-hover:text-ink"
            style={{
              writingMode: "vertical-rl",
              transform: "rotate(180deg)",
              letterSpacing: "0.02em",
            }}
          >
            {tab.title}
          </span>
          <span
            className="shrink-0 font-mono text-xs text-ink-muted"
            style={{ writingMode: "vertical-rl", letterSpacing: "0.08em" }}
          >
            ⌘J
          </span>
        </button>
      )}
    </section>
  );
}
