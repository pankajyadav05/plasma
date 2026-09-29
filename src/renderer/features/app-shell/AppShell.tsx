import { CodegenDialog } from '@/features/codegen/CodegenDialog';
import { CommandPalette } from '@/features/command-palette/CommandPalette';
import { ConnectionDialog } from '@/features/connection-manager/ConnectionDialog';
import { DeleteConfirmDialog } from '@/features/connection-manager/DeleteConfirmDialog';
import { PendingEditsGateDialog } from '@/features/connection-manager/PendingEditsGateDialog';
import { ProdGateDialog } from '@/features/connection-manager/ProdGateDialog';
import { EditorResizer } from '@/features/editor/EditorResizer';
import { SqlCanvas } from '@/features/editor/SqlCanvas';
import { TabStrip } from '@/features/editor/TabStrip';
import { HistoryCanvas } from '@/features/history/HistoryCanvas';
import { HistorySheet } from '@/features/history/HistorySheet';
import { ShortcutCheatSheet } from '@/features/keymap/ShortcutCheatSheet';
import { MonitorCanvas } from '@/features/monitor/MonitorCanvas';
import { NotebookDialog } from '@/features/notebook/NotebookDialog';
import { DeleteIndexDialog } from '@/features/opensearch/DeleteIndexDialog';
import { NewIndexDialog } from '@/features/opensearch/NewIndexDialog';
import { OsCanvas } from '@/features/opensearch/OsCanvas';
import { RedisCanvas } from '@/features/redis/RedisCanvas';
import { FilterRow } from '@/features/result-grid/FilterRow';
import { ResultGrid } from '@/features/result-grid/ResultGrid';
import { ResultFooter } from '@/features/result-grid/ResultFooter';
import { ResultMessagesPanel, ResultTabs } from '@/features/result-grid/ResultTabs';
import { RightRail } from '@/features/right-rail/RightRail';
import { SchemaDiffDialog } from '@/features/schema-diff/SchemaDiffDialog';
import { SettingsCanvas } from '@/features/settings/SettingsCanvas';
import { SettingsSheet } from '@/features/settings/SettingsSheet';
import { Sidebar } from '@/features/sidebar/Sidebar';
import { ChartBody } from '@/features/chart/ChartDialog';
import { useActiveTab, useSession } from '@/stores/session';
import { useWorkbench } from '@/stores/workbench';
import { matchGlobalBinding } from '@shared/keymap';
import { useEffect, useState } from 'react';
import { DisconnectedHome } from './DisconnectedHome';
import { IconRail } from './IconRail';
import { SidebarResizer } from './SidebarResizer';
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
  const [cheatSheetOpen, setCheatSheetOpen] = useState(false);

  // Global shortcuts — chords come from `@shared/keymap`. ⌘K is the
  // command palette (DESIGN.md); AI panel is ⌘L; ⌘/ opens this cheat-sheet.
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

      // ⌘1…⌘9 jump straight to a tab (⌘9 = last, browser convention).
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        const { tabs, setActiveTab } = useSession.getState();
        const n = Number(e.key);
        const target = n === 9 ? tabs[tabs.length - 1] : tabs[n - 1];
        if (target) {
          e.preventDefault();
          setActiveTab(target.id);
        }
        return;
      }

      const hit = matchGlobalBinding(e);
      if (!hit) return;

      // Skip editor-adjacent toggles while typing in a plain input, but
      // always allow palette / AI / cheat-sheet (Linear/Raycast pattern)
      // and pane/tab navigation.
      const allowInInput =
        hit.id === 'palette' ||
        hit.id === 'toggleAi' ||
        hit.id === 'cheatSheet' ||
        hit.id === 'nextTab' ||
        hit.id === 'prevTab' ||
        hit.id === 'toggleRightSidebar';
      if (inInput && !allowInInput) return;

      // Menu-owned run/cancel/new-tab/etc. still arrive via IPC; only
      // handle the DOM-primary actions here to avoid double-firing when
      // a native accelerator also delivers a keydown.
      switch (hit.id) {
        case 'palette':
          e.preventDefault();
          useSession.getState().togglePalette();
          break;
        case 'toggleAi':
          e.preventDefault();
          {
            const cur = useSession.getState().rightPanelMode;
            useSession.getState().setRightPanelMode(cur === 'ai' ? null : 'ai');
          }
          break;
        case 'cheatSheet':
          e.preventDefault();
          setCheatSheetOpen((v) => !v);
          break;
        case 'nextTab':
        case 'prevTab': {
          e.preventDefault();
          const { tabs, activeTabId, setActiveTab } = useSession.getState();
          if (tabs.length < 2) break;
          const idx = tabs.findIndex((t) => t.id === activeTabId);
          const step = hit.id === 'nextTab' ? 1 : -1;
          const next = tabs[(idx + step + tabs.length) % tabs.length];
          if (next) setActiveTab(next.id);
          break;
        }
        case 'toggleRightSidebar': {
          e.preventDefault();
          const st = useSession.getState();
          if (st.canvasMode !== 'database') break;
          st.setRightPanelMode(st.rightPanelMode ? null : 'details');
          break;
        }
        case 'toggleEditor':
          e.preventDefault();
          useSession.getState().toggleEditor();
          break;
        case 'toggleSidebar':
          e.preventDefault();
          void useSession.getState().toggleSidebar();
          break;
        case 'codegen':
          e.preventDefault();
          setCodegenOpen(true);
          break;
        case 'notebook':
          e.preventDefault();
          setNotebookOpen(true);
          break;
        case 'schemaDiff':
          e.preventDefault();
          setSchemaDiffOpen(true);
          break;
        default:
          // runQuery / cancelQuery / history / tabs / export — menu IPC
          break;
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // Native menu → cheat-sheet / AI (channels registered in preload).
  useEffect(() => {
    const unsub = [
      window.plasmaEvents.on('plasma:menu:cheatSheet', () => setCheatSheetOpen(true)),
      window.plasmaEvents.on('plasma:menu:toggleAi', () => {
        const cur = useSession.getState().rightPanelMode;
        useSession.getState().setRightPanelMode(cur === 'ai' ? null : 'ai');
      }),
    ];
    return () => {
      for (const fn of unsub) fn();
    };
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

      </div>

      {/* Overlays */}
      {dialogOpen && <ConnectionDialog />}
      <CommandPalette />
      <SettingsSheet />
      <HistorySheet />
      <DeleteConfirmDialog />
      <ProdGateDialog />
      <PendingEditsGateDialog />
      <NewIndexDialog />
      <DeleteIndexDialog />
      <CodegenDialog open={codegenOpen} onOpenChange={setCodegenOpen} />
      <SchemaDiffDialog open={schemaDiffOpen} onOpenChange={setSchemaDiffOpen} />
      <NotebookDialog open={notebookOpen} onOpenChange={setNotebookOpen} />
      <ShortcutCheatSheet open={cheatSheetOpen} onOpenChange={setCheatSheetOpen} />
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
    <div className="flex min-h-0 flex-1 bg-[var(--wb-content)]">
      <IconRail />

      {!fullPage && (
        <>
          <aside
            className={
              sidebarCollapsed
                ? 'relative shrink-0 overflow-hidden bg-[var(--wb-sidebar)] text-[var(--wb-text)]'
                : 'relative shrink-0 overflow-hidden border-r border-[var(--wb-separator)] bg-[var(--wb-sidebar)] text-[var(--wb-text)]'
            }
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
  const hasResultOrError = Boolean(
    tab?.queryResult ||
    (tab?.queryResults && tab.queryResults.length > 0) ||
    tab?.queryError,
  );
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--wb-content)]">
      <TabStrip />
      <SqlCanvas expanded={!hasResultOrError} />
      {hasResultOrError && (
        <>
          <EditorResizer />
          <ResultTabs />
          <ResultBody />
          <ResultFooter />
        </>
      )}
    </main>
  );
}

function DatabaseCanvas() {
  const tab = useActiveTab();
  const isTableData = tab?.kind === 'table' && tab.viewMode === 'data';
  // SQL tabs get Monaco inline. When there's no result yet, the editor
  // expands to fill the canvas. Once a query has run, the editor keeps
  // its user-sized height and the results take the rest.
  const isSqlTab = tab?.kind === 'sql';
  const hasResultOrError = Boolean(
    tab?.queryResult ||
    (tab?.queryResults && tab.queryResults.length > 0) ||
    tab?.queryError,
  );
  const showGrid = !isSqlTab || hasResultOrError;
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--wb-content)]">
      <TabStrip />
      {isSqlTab && <SqlCanvas expanded={!hasResultOrError} />}
      {isSqlTab && hasResultOrError && <EditorResizer />}
      {isTableData && <FilterRow />}
      {showGrid && isSqlTab && <ResultTabs />}
      {showGrid && <ResultBody />}
      {showGrid && <ResultFooter />}
    </main>
  );
}

/**
 * What sits above the footer: the grid, or — for SQL tabs — the
 * footer's Message / Chart views (TablePlus Data · Message · Chart).
 */
function ResultBody() {
  const tab = useActiveTab();
  const view = useWorkbench((s) => (tab ? (s.resultViews[tab.id] ?? 'data') : 'data'));
  if (tab?.kind === 'sql' && view === 'message') return <ResultMessagesPanel />;
  if (tab?.kind === 'sql' && view === 'chart') {
    const result = tab.queryResult;
    return (
      <div className="min-h-0 flex-1 overflow-auto bg-[var(--wb-content)] p-4">
        {result && result.columns.length > 0 ? (
          <ChartBody
            key={`${tab.id}-${tab.activeResultIndex}-${result.durationMs}`}
            result={result}
            tall
          />
        ) : (
          <div className="grid h-full place-items-center text-[13px] text-[var(--wb-text-2)]">
            Nothing to chart — run a query that returns rows.
          </div>
        )}
      </div>
    );
  }
  return <ResultGrid />;
}
