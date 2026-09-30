import { BackupDialog } from '@/features/backup/BackupDialog';
import { RestoreDialog } from '@/features/backup/RestoreDialog';
import { ChartBody } from '@/features/chart/ChartDialog';
import { CodegenDialog } from '@/features/codegen/CodegenDialog';
import { CommandPalette } from '@/features/command-palette/CommandPalette';
import { ConnectionDialog } from '@/features/connection-manager/ConnectionDialog';
import { DeleteConfirmDialog } from '@/features/connection-manager/DeleteConfirmDialog';
import { PendingEditsGateDialog } from '@/features/connection-manager/PendingEditsGateDialog';
import { ProdGateDialog } from '@/features/connection-manager/ProdGateDialog';
import { DbSearchDialog } from '@/features/db-search/DbSearchDialog';
import { CloseTabsDialog } from '@/features/editor/CloseTabsDialog';
import { EditorResizer } from '@/features/editor/EditorResizer';
import { RunningPlaceholder } from '@/features/editor/RunningPlaceholder';
import { SqlCanvas } from '@/features/editor/SqlCanvas';
import { TabStrip } from '@/features/editor/TabStrip';
import { ErDiagramView } from '@/features/er-diagram/ErDiagramView';
import { HistoryCanvas } from '@/features/history/HistoryCanvas';
import { ShortcutCheatSheet } from '@/features/keymap/ShortcutCheatSheet';
import { runCommand, selectTabAt } from '@/features/keymap/commands';
import { MonitorCanvas } from '@/features/monitor/MonitorCanvas';
import { NotebookDialog } from '@/features/notebook/NotebookDialog';
import { DeleteIndexDialog } from '@/features/opensearch/DeleteIndexDialog';
import { NewIndexDialog } from '@/features/opensearch/NewIndexDialog';
import { OsCanvas } from '@/features/opensearch/OsCanvas';
import { RedisCanvas } from '@/features/redis/RedisCanvas';
import { FilterRow } from '@/features/result-grid/FilterRow';
import { ResultFooter } from '@/features/result-grid/ResultFooter';
import { ResultGrid } from '@/features/result-grid/ResultGrid';
import { ResultMessagesPanel, ResultTabs } from '@/features/result-grid/ResultTabs';
import { RightRail } from '@/features/right-rail/RightRail';
import { RolesDialog } from '@/features/roles/RolesDialog';
import { SchemaDiffDialog } from '@/features/schema-diff/SchemaDiffDialog';
import { SettingsCanvas } from '@/features/settings/SettingsCanvas';
import { Sidebar } from '@/features/sidebar/Sidebar';
import { StructureDialogsHost } from '@/features/structure/StructureDialogsHost';
import { PaneTabContext } from '@/stores/pane-context';
import { type PaneId, activeIn, isSplit } from '@/stores/pane-state';
import { usePanes } from '@/stores/panes';
import { useActiveTabSelect, useSession } from '@/stores/session';
import { type Overlay, useWorkbench } from '@/stores/workbench';
import { type KeyId, matchGlobalBinding, selectTabIndex } from '@shared/keymap';
import { useEffect, useRef } from 'react';
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
  const overlay = useWorkbench((s) => s.overlay);
  const setOverlay = useWorkbench((s) => s.setOverlay);
  const overlayProps = (name: NonNullable<Overlay>) => ({
    open: overlay === name,
    onOpenChange: (open: boolean) => setOverlay(open ? name : null),
  });

  // Global shortcuts — chords come from `@shared/keymap` and dispatch
  // through `runCommand`, the same table the native menu and the palette
  // use. Handled chords are preventDefault-ed so the native accelerator
  // never fires a second time. Monaco handles its own keys (and forwards
  // the global chords it would otherwise swallow — see MonacoEditor).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target?.closest('.monaco-editor')) return;
      const tag = (target?.tagName ?? '').toLowerCase();
      const inInput =
        tag === 'input' ||
        tag === 'textarea' ||
        tag === 'select' ||
        Boolean(target?.isContentEditable);

      if (e.key === 'Escape' && !inInput) {
        const m = useSession.getState().canvasMode;
        if (m === 'settings' || m === 'history' || m === 'monitor') {
          e.preventDefault();
          useSession.getState().setCanvasMode('database');
          return;
        }
      }

      // ⌘1…⌘9 jump straight to a tab (⌘9 = last, browser convention).
      const tabIndex = selectTabIndex(e);
      if (tabIndex !== null) {
        if (useSession.getState().connectionState !== 'connected') return;
        e.preventDefault();
        selectTabAt(tabIndex);
        return;
      }

      const hit = matchGlobalBinding(e);
      if (!hit) return;
      // Plain inputs keep Enter-ish chords (run / cancel / export) for
      // themselves; navigation and panel chords work everywhere.
      if (inInput && TYPING_CHORDS.has(hit.id)) return;
      if (runCommand(hit.id)) e.preventDefault();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const disconnected = connectionState !== 'connected';
  // Settings is reachable without a connection (palette / menu / home).
  const settingsWhileDisconnected = useSession(
    (s) => s.canvasMode === 'settings' && s.connectionState !== 'connected',
  );

  return (
    <>
      <div className="flex h-screen flex-col">
        <TopBar />

        {disconnected ? (
          <div className="flex min-h-0 flex-1 flex-col">
            {settingsWhileDisconnected ? <SettingsCanvas /> : <DisconnectedHome />}
          </div>
        ) : (
          <ConnectedShell />
        )}
      </div>

      {/* Overlays */}
      {dialogOpen && <ConnectionDialog />}
      <CommandPalette />
      <DeleteConfirmDialog />
      <ProdGateDialog />
      <PendingEditsGateDialog />
      <NewIndexDialog />
      <StructureDialogsHost />
      <DeleteIndexDialog />
      <CloseTabsDialog />
      <CodegenDialog {...overlayProps('codegen')} />
      <SchemaDiffDialog {...overlayProps('schemaDiff')} />
      <NotebookDialog {...overlayProps('notebook')} />
      <ShortcutCheatSheet {...overlayProps('cheatSheet')} />
      <BackupDialog {...overlayProps('backup')} />
      <RestoreDialog {...overlayProps('restore')} />
      <RolesDialog {...overlayProps('roles')} />
      <DbSearchDialog {...overlayProps('dbSearch')} />
    </>
  );
}

/** Chords a focused plain input keeps (e.g. ⌘⏎ in a filter field). */
const TYPING_CHORDS: ReadonlySet<KeyId> = new Set<KeyId>([
  'runQuery',
  'runQueryAll',
  'cancelQuery',
  'exportCsv',
]);

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
      ) : (
        <EngineCanvas />
      )}

      {/* RightRail only makes sense for relational (Postgres) databases —
          Query / Role / RLS are scoped to a table or active SQL query.
          Hidden for the full-page Settings / History / Monitor modes. */}
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

function DatabaseCanvas() {
  const split = usePanes((s) => isSplit(s));
  // No split: exactly the single-pane layout, no wrapper, no context.
  if (!split) return <PaneCanvas />;
  return <SplitCanvas />;
}

/** Two panes side by side; each renders its own active tab (TablePlus "Split pane right"). */
function SplitCanvas() {
  const paneState = usePanes();
  const tabIds = useSession((s) => s.tabs.map((t) => t.id).join('\u0001'));
  const ids = tabIds.split('\u0001');
  return (
    <div className="flex min-h-0 min-w-0 flex-1" data-testid="split-panes">
      {(['primary', 'secondary'] as const).map((pane) => (
        <PaneSlot
          key={pane}
          pane={pane}
          tabId={activeIn(paneState, ids, pane)}
          focused={paneState.focus === pane}
        />
      ))}
    </div>
  );
}

function PaneSlot({
  pane,
  tabId,
  focused,
}: { pane: PaneId; tabId: string | null; focused: boolean }) {
  const focusPane = usePanes((s) => s.focusPane);
  const slotRef = useRef<HTMLDivElement>(null);
  const wasFocused = useRef(focused);
  // ⌥⌘]/⌥⌘[ change the focused pane from the keyboard: move DOM focus into
  // it too, otherwise typing keeps going to the pane you just left.
  useEffect(() => {
    const el = slotRef.current;
    if (focused && !wasFocused.current && el && !el.contains(document.activeElement)) {
      el.querySelector<HTMLElement>('.monaco-editor textarea, [role="grid"]')?.focus();
    }
    wasFocused.current = focused;
  }, [focused]);
  return (
    <PaneTabContext.Provider value={tabId}>
      <div
        ref={slotRef}
        className={
          pane === 'secondary'
            ? 'flex min-h-0 min-w-0 flex-1 basis-0 border-l border-[var(--wb-separator)]'
            : 'flex min-h-0 min-w-0 flex-1 basis-0'
        }
        data-pane={pane}
        data-focused={focused || undefined}
        // Interacting with a pane makes it the focused one, so "the active
        // tab" everywhere else in the app means this pane's tab.
        onPointerDownCapture={() => focusPane(pane)}
        onFocusCapture={() => focusPane(pane)}
      >
        <PaneCanvas pane={pane} />
      </div>
    </PaneTabContext.Provider>
  );
}

function PaneCanvas({ pane }: { pane?: PaneId } = {}) {
  // Narrow selectors (F13): typing in the editor patches `sql` on every
  // keystroke; this layout only re-renders when its shape changes.
  const { kind, viewMode, hasResultOrError, running } = useActiveTabSelect((t) => ({
    kind: t?.kind,
    viewMode: t?.viewMode,
    hasResultOrError: Boolean(
      t?.queryResult || (t?.queryResults?.length ?? 0) > 0 || t?.queryError,
    ),
    running: t?.queryRunState === 'running',
  }));
  const editorHidden = useWorkbench((s) => s.editorHidden);
  const isTableData = kind === 'table' && viewMode === 'data';
  // SQL tabs get Monaco inline. Before the first run the editor fills the
  // canvas; once a query runs (VF20: already while it runs, so the layout
  // doesn't jump) the editor keeps its user-sized height and the results
  // take the rest. ⌘J hides the editor while there are results to show.
  const isSqlTab = kind === 'sql';
  const isDiagram = kind === 'er-diagram';
  const hasResults = hasResultOrError || running;
  const showEditor = isSqlTab && (!editorHidden || !hasResults);
  const showGrid = !isDiagram && (!isSqlTab || hasResults);
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--wb-content)]">
      <TabStrip pane={pane} />
      {isDiagram && <ErDiagramView />}
      {showEditor && <SqlCanvas expanded={!hasResults} />}
      {showEditor && hasResults && <EditorResizer />}
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
  const tab = useActiveTabSelect((t) => ({
    id: t?.id,
    kind: t?.kind,
    result: t?.queryResult ?? null,
    resultCount: t?.queryResults?.length ?? 0,
    error: t?.queryError ?? null,
    running: t?.queryRunState === 'running',
    runStartedAt: (t?.runStartedAt as number | undefined) ?? null,
    activeResultIndex: t?.activeResultIndex ?? 0,
  }));
  const view = useWorkbench((s) => (tab.id ? (s.resultViews[tab.id] ?? 'data') : 'data'));
  // VF20: while the first statement runs, keep the pane with an elapsed
  // timer instead of collapsing it.
  if (tab.kind === 'sql' && tab.running && tab.resultCount === 0 && !tab.error) {
    return <RunningPlaceholder startedAt={tab.runStartedAt} />;
  }
  if (tab.kind === 'sql' && view === 'message') return <ResultMessagesPanel />;
  if (tab.kind === 'sql' && view === 'chart') {
    const result = tab.result;
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
