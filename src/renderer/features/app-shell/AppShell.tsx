import { CodegenDialog } from '@/features/codegen/CodegenDialog';
import { CommandPalette } from '@/features/command-palette/CommandPalette';
import { ConnectionDialog } from '@/features/connection-manager/ConnectionDialog';
import { DeleteConfirmDialog } from '@/features/connection-manager/DeleteConfirmDialog';
import { ProdGateDialog } from '@/features/connection-manager/ProdGateDialog';
import { EditorResizer } from '@/features/editor/EditorResizer';
import { SqlCanvas } from '@/features/editor/SqlCanvas';
import { TabStrip } from '@/features/editor/TabStrip';
import { HistoryCanvas } from '@/features/history/HistoryCanvas';
import { HistorySheet } from '@/features/history/HistorySheet';
import { MonitorCanvas } from '@/features/monitor/MonitorCanvas';
import { NotebookDialog } from '@/features/notebook/NotebookDialog';
import { DeleteIndexDialog } from '@/features/opensearch/DeleteIndexDialog';
import { NewIndexDialog } from '@/features/opensearch/NewIndexDialog';
import { OsCanvas } from '@/features/opensearch/OsCanvas';
import { RedisCanvas } from '@/features/redis/RedisCanvas';
import { FilterRow } from '@/features/result-grid/FilterRow';
import { PaginationBar } from '@/features/result-grid/PaginationBar';
import { PendingEditsTray } from '@/features/result-grid/PendingEditsTray';
import { ResultGrid } from '@/features/result-grid/ResultGrid';
import { ResultToolbar } from '@/features/result-grid/ResultToolbar';
import { RightRail } from '@/features/right-rail/RightRail';
import { SchemaDiffDialog } from '@/features/schema-diff/SchemaDiffDialog';
import { SettingsCanvas } from '@/features/settings/SettingsCanvas';
import { SettingsSheet } from '@/features/settings/SettingsSheet';
import { Sidebar } from '@/features/sidebar/Sidebar';
import { useActiveTab, useSession } from '@/stores/session';
import { useEffect, useState } from 'react';
import { DisconnectedHome } from './DisconnectedHome';
import { IconRail } from './IconRail';
import { SidebarResizer } from './SidebarResizer';
import { StatusBar } from './StatusBar';
import { TopBar } from './TopBar';

/**
 * AppShell decides which top-level layout to render:
 *
 *   - disconnected         → DisconnectedHome (full window, slim topbar)
 *   - canvasMode=settings  → SettingsCanvas (full window, close button)
 *   - canvasMode=history   → HistoryCanvas (full window, close button)
 *   - default              → standard shell (rail + sidebar + tabs + grid)
 *
 * "Full window" pages skip the icon rail and sidebar entirely so they
 * read as their own destinations rather than nested into the database
 * browser layout.
 */
export function AppShell() {
  const dialogOpen = useSession((s) => s.dialogOpen);
  const connectionState = useSession((s) => s.connectionState);
  const [codegenOpen, setCodegenOpen] = useState(false);
  const [notebookOpen, setNotebookOpen] = useState(false);
  const [schemaDiffOpen, setSchemaDiffOpen] = useState(false);

  // Global shortcuts: ⌘J toggle editor, ⌘B toggle sidebar, Esc closes
  // settings/history full-window canvases back to database.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? '').toLowerCase();
      const inInput = tag === 'input' || tag === 'textarea' || tag === 'select';
      if (e.key === 'Escape' && !inInput) {
        const m = useSession.getState().canvasMode;
        if (m === 'settings' || m === 'history' || m === 'monitor') {
          e.preventDefault();
          useSession.getState().setCanvasMode('database');
          return;
        }
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() === 'j' && !inInput) {
        e.preventDefault();
        useSession.getState().toggleEditor();
      } else if (e.key.toLowerCase() === 'b' && !inInput) {
        e.preventDefault();
        void useSession.getState().toggleSidebar();
      } else if (e.key.toLowerCase() === 'k') {
        // ⌘K toggles the AI panel (works even when an input is focused —
        // common Linear/Raycast pattern). Lowercase comparison covers
        // Shift-K (some terminals send 'K' when capslock is engaged).
        e.preventDefault();
        const cur = useSession.getState().rightPanelMode;
        useSession.getState().setRightPanelMode(cur === 'ai' ? null : 'ai');
      } else if (e.shiftKey && e.key.toLowerCase() === 'g') {
        // ⌘⇧G — open the codegen dialog.
        e.preventDefault();
        setCodegenOpen(true);
      } else if (e.shiftKey && e.key.toLowerCase() === 'n') {
        // ⌘⇧N — open the notebook canvas.
        e.preventDefault();
        setNotebookOpen(true);
      } else if (e.shiftKey && e.key.toLowerCase() === 'd') {
        // ⌘⇧D — schema diff.
        e.preventDefault();
        setSchemaDiffOpen(true);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const disconnected = connectionState !== 'connected';

  return (
    <>
      <div className="flex h-screen flex-col">
        <TopBar />

        {disconnected ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <DisconnectedHome />
          </div>
        ) : (
          <ConnectedShell />
        )}

        <StatusBar />
      </div>

      {/* Overlays */}
      {dialogOpen && <ConnectionDialog />}
      <CommandPalette />
      <SettingsSheet />
      <HistorySheet />
      <DeleteConfirmDialog />
      <ProdGateDialog />
      <NewIndexDialog />
      <DeleteIndexDialog />
      <CodegenDialog open={codegenOpen} onOpenChange={setCodegenOpen} />
      <SchemaDiffDialog open={schemaDiffOpen} onOpenChange={setSchemaDiffOpen} />
      <NotebookDialog open={notebookOpen} onOpenChange={setNotebookOpen} />
    </>
  );
}

function ConnectedShell() {
  const sidebarCollapsed = useSession((s) => s.settings.sidebarCollapsed);
  const sidebarWidth = useSession((s) => s.settings.sidebarWidth);
  const canvasMode = useSession((s) => s.canvasMode);

  // Settings + History + Monitor are full-page replacements for the
  // sidebar + main area, but the IconRail (left) stays visible so the
  // user never loses navigation context.
  const fullPage =
    canvasMode === 'settings' || canvasMode === 'history' || canvasMode === 'monitor';

  return (
    <div className="flex min-h-0 flex-1">
      <IconRail />

      {!fullPage && (
        <>
          <aside
            className="relative shrink-0 overflow-hidden border-r bg-sidebar text-sidebar-foreground"
            style={{
              width: sidebarCollapsed ? 0 : sidebarWidth,
              transition: 'width 220ms cubic-bezier(0.16, 1, 0.3, 1)',
            }}
            aria-hidden={sidebarCollapsed}
          >
            <div className="h-full" style={{ width: sidebarWidth }}>
              <Sidebar />
            </div>
          </aside>
          <SidebarResizer />
        </>
      )}

      {canvasMode === 'settings' ? (
        <SettingsCanvas />
      ) : canvasMode === 'history' ? (
        <HistoryCanvas />
      ) : canvasMode === 'monitor' ? (
        <MonitorCanvas />
      ) : canvasMode === 'sql' ? (
        <SqlOnlyCanvas />
      ) : (
        <EngineCanvas />
      )}

      {/* RightRail only makes sense for relational (Postgres) databases —
          Query / Role / RLS are scoped to a table or active SQL query.
          Hidden for redis/opensearch and for SQL / Settings / History modes. */}
      {canvasMode === 'database' && <PostgresRightRail />}
    </div>
  );
}

function PostgresRightRail() {
  // The right rail itself filters its contents per engine — postgres
  // shows query/role/rls/saved + AI, while redis/opensearch keep only
  // the AI panel. Render it in both cases so the AI sidecar is reachable
  // everywhere.
  return <RightRail />;
}

/**
 * Branch on the active connection's engine to render the right canvas.
 * Each non-relational engine ships with its own home/list/detail panes
 * and ignores the SQL editor, filter row, and result grid that the
 * Postgres canvas wires together.
 */
function EngineCanvas() {
  const engine = useSession((s) => s.activeConfig?.engine ?? 'postgres');
  if (engine === 'redis') return <RedisCanvas />;
  if (engine === 'opensearch') return <OsCanvas />;
  return <DatabaseCanvas />;
}

function SqlOnlyCanvas() {
  const tab = useActiveTab();
  const hasResultOrError = Boolean(tab?.queryResult || tab?.queryError);
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <TabStrip />
      <SqlCanvas expanded={!hasResultOrError} />
      {hasResultOrError && (
        <>
          <EditorResizer />
          <ResultGrid />
          <PendingEditsTray />
          <PaginationBar />
        </>
      )}
    </main>
  );
}

function DatabaseCanvas() {
  const tab = useActiveTab();
  const showFilterRow = tab?.kind === 'table' && tab.viewMode !== 'definition';
  // SQL tabs get Monaco inline. When there's no result yet, the editor
  // expands to fill the canvas (the "P · start where you left off" home
  // panel is suppressed). Once a query has run, the editor caps at ~40%
  // and the result grid takes the rest.
  const isSqlTab = tab?.kind === 'sql';
  const hasResultOrError = Boolean(tab?.queryResult || tab?.queryError);
  const showGrid = !isSqlTab || hasResultOrError;
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <TabStrip />
      {isSqlTab && <SqlCanvas expanded={!hasResultOrError} />}
      {isSqlTab && hasResultOrError && <EditorResizer />}
      {showFilterRow && <FilterRow />}
      {showGrid && <ResultToolbar />}
      {showGrid && <ResultGrid />}
      <PendingEditsTray />
      {showGrid && <PaginationBar />}
    </main>
  );
}
