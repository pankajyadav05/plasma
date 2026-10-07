import { CommandPalette } from '@/features/command-palette/CommandPalette';
import { DeleteConfirmDialog } from '@/features/connection-manager/DeleteConfirmDialog';
import { PendingEditsGateDialog } from '@/features/connection-manager/PendingEditsGateDialog';
import { ProdGateDialog } from '@/features/connection-manager/ProdGateDialog';
import { CloseTabsDialog } from '@/features/editor/CloseTabsDialog';
import { EditorResizer } from '@/features/editor/EditorResizer';
import { RunningPlaceholder } from '@/features/editor/RunningPlaceholder';
import { SqlCanvas } from '@/features/editor/SqlCanvas';
import { TabStrip } from '@/features/editor/TabStrip';
import { VariablesBar } from '@/features/editor/VariablesBar';
import { runCommand, selectTabAt } from '@/features/keymap/commands';
import { MigrationCheckDialog } from '@/features/migration/MigrationCheckDialog';
import { EditConflictDialog } from '@/features/result-grid/EditConflictDialog';
import { FilterRow } from '@/features/result-grid/FilterRow';
import { ResultFooter } from '@/features/result-grid/ResultFooter';
import { ResultGrid } from '@/features/result-grid/ResultGrid';
import { ResultMessagesPanel, ResultTabs } from '@/features/result-grid/ResultTabs';
import { RightRail } from '@/features/right-rail/RightRail';
import { SafeRunPanel } from '@/features/safe-run/SafeRunPanel';
import { Sidebar } from '@/features/sidebar/Sidebar';
import { SnippetEditorDialog } from '@/features/snippets/SnippetEditorDialog';
import { LazyOnOpen, lazyNamed } from '@/lib/lazy';
import { PaneTabContext } from '@/stores/pane-context';
import { type PaneId, activeIn, isSplit } from '@/stores/pane-state';
import { usePanes } from '@/stores/panes';
import { useActiveTabSelect, useSession } from '@/stores/session';
import { type Overlay, useWorkbench } from '@/stores/workbench';
import { type KeyId, matchGlobalBinding, selectTabIndex } from '@shared/keymap';
import { Suspense, useEffect, useRef } from 'react';
import { DisconnectedHome } from './DisconnectedHome';
import { IconRail } from './IconRail';
import { SidebarResizer } from './SidebarResizer';
import { TopBar } from './TopBar';

// Heavy feature modules load on demand so the first-load chunk stays small.
const ConnectionsCanvas = lazyNamed(
  () => import('@/features/connection-manager/ConnectionsCanvas'),
  'ConnectionsCanvas',
);
const BackupDialog = lazyNamed(() => import('@/features/backup/BackupDialog'), 'BackupDialog');
const SqliteBackupDialog = lazyNamed(
  () => import('@/features/backup/SqliteBackupDialog'),
  'SqliteBackupDialog',
);
const RestoreDialog = lazyNamed(() => import('@/features/backup/RestoreDialog'), 'RestoreDialog');
const ChartBody = lazyNamed(() => import('@/features/chart/ChartDialog'), 'ChartBody');
const CodegenDialog = lazyNamed(() => import('@/features/codegen/CodegenDialog'), 'CodegenDialog');
const DbSearchDialog = lazyNamed(
  () => import('@/features/db-search/DbSearchDialog'),
  'DbSearchDialog',
);
const PgListenView = lazyNamed(() => import('@/features/live-tail/PgListenView'), 'PgListenView');
const ErDiagramView = lazyNamed(
  () => import('@/features/er-diagram/ErDiagramView'),
  'ErDiagramView',
);
const HistoryCanvas = lazyNamed(() => import('@/features/history/HistoryCanvas'), 'HistoryCanvas');
const HealthCanvas = lazyNamed(() => import('@/features/monitor/HealthCanvas'), 'HealthCanvas');
const NotebookDialog = lazyNamed(
  () => import('@/features/notebook/NotebookDialog'),
  'NotebookDialog',
);
const DeleteIndexDialog = lazyNamed(
  () => import('@/features/opensearch/DeleteIndexDialog'),
  'DeleteIndexDialog',
);
const NewIndexDialog = lazyNamed(
  () => import('@/features/opensearch/NewIndexDialog'),
  'NewIndexDialog',
);
const OsCanvas = lazyNamed(() => import('@/features/opensearch/OsCanvas'), 'OsCanvas');
const RedisCanvas = lazyNamed(() => import('@/features/redis/RedisCanvas'), 'RedisCanvas');
const RolesDialog = lazyNamed(() => import('@/features/roles/RolesDialog'), 'RolesDialog');
const SchemaDiffDialog = lazyNamed(
  () => import('@/features/schema-diff/SchemaDiffDialog'),
  'SchemaDiffDialog',
);
const SettingsCanvas = lazyNamed(
  () => import('@/features/settings/SettingsCanvas'),
  'SettingsCanvas',
);
const StructureDialogsHost = lazyNamed(
  () => import('@/features/structure/StructureDialogsHost'),
  'StructureDialogsHost',
);
const ShortcutCheatSheet = lazyNamed(
  () => import('@/features/keymap/ShortcutCheatSheet'),
  'ShortcutCheatSheet',
);

/**
 * AppShell decides which top-level layout to render:
 *
 *   - disconnected         → DisconnectedHome (full window, slim topbar)
 *   - canvasMode=settings  → SettingsCanvas (full window, close button)
 *   - canvasMode=history   → HistoryCanvas (full window, close button)
 *   - canvasMode=connections → ConnectionsCanvas (full window, close button)
 *   - default              → standard shell (rail + sidebar + tabs + grid)
 *
 * "Full window" pages skip the icon rail and sidebar entirely so they
 * read as their own destinations rather than nested into the database
 * browser layout.
 */
export function AppShell() {
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
        if (m === 'connections') {
          e.preventDefault();
          useSession.getState().closeDialog();
          return;
        }
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
  const connectionsWhileDisconnected = useSession(
    (s) => s.canvasMode === 'connections' && s.connectionState !== 'connected',
  );

  return (
    <>
      <div className="flex h-screen flex-col">
        <TopBar />

        {disconnected ? (
          <div className="flex min-h-0 flex-1 flex-col">
            {settingsWhileDisconnected ? (
              <Suspense fallback={null}>
                <SettingsCanvas />
              </Suspense>
            ) : connectionsWhileDisconnected ? (
              <Suspense fallback={null}>
                <ConnectionsCanvas />
              </Suspense>
            ) : (
              <DisconnectedHome />
            )}
          </div>
        ) : (
          <ConnectedShell />
        )}
      </div>

      {/* Overlays */}
      <CommandPalette />
      <DeleteConfirmDialog />
      <ProdGateDialog />
      <PendingEditsGateDialog />
      <EditConflictDialog />
      <CloseTabsDialog />
      <SnippetEditorDialog />
      <MigrationCheckDialog />
      {/* Store-gated dialogs: lazy chunks that load right after first paint. */}
      <Suspense fallback={null}>
        <NewIndexDialog />
        <StructureDialogsHost />
        <DeleteIndexDialog />
      </Suspense>
      {/* Overlay dialogs: the chunk is requested the first time one opens. */}
      <LazyOnOpen open={overlay === 'codegen'}>
        <CodegenDialog {...overlayProps('codegen')} />
      </LazyOnOpen>
      <LazyOnOpen open={overlay === 'schemaDiff'}>
        <SchemaDiffDialog {...overlayProps('schemaDiff')} />
      </LazyOnOpen>
      <LazyOnOpen open={overlay === 'notebook'}>
        <NotebookDialog {...overlayProps('notebook')} />
      </LazyOnOpen>
      <LazyOnOpen open={overlay === 'cheatSheet'}>
        <ShortcutCheatSheet {...overlayProps('cheatSheet')} />
      </LazyOnOpen>
      <LazyOnOpen open={overlay === 'backup'}>
        <BackupDialog {...overlayProps('backup')} />
      </LazyOnOpen>
      <LazyOnOpen open={overlay === 'sqliteBackup'}>
        <SqliteBackupDialog {...overlayProps('sqliteBackup')} />
      </LazyOnOpen>
      <LazyOnOpen open={overlay === 'restore'}>
        <RestoreDialog {...overlayProps('restore')} />
      </LazyOnOpen>
      <LazyOnOpen open={overlay === 'roles'}>
        <RolesDialog {...overlayProps('roles')} />
      </LazyOnOpen>
      <LazyOnOpen open={overlay === 'dbSearch'}>
        <DbSearchDialog {...overlayProps('dbSearch')} />
      </LazyOnOpen>
    </>
  );
}

/** Chords a focused plain input keeps (e.g. ⌘⏎ in a filter field). */
const TYPING_CHORDS: ReadonlySet<KeyId> = new Set<KeyId>([
  'runQuery',
  'runQueryAll',
  'safeRun',
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
    canvasMode === 'settings' ||
    canvasMode === 'history' ||
    canvasMode === 'monitor' ||
    canvasMode === 'connections';

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

      <Suspense fallback={<main className="min-w-0 flex-1 bg-[var(--wb-content)]" />}>
        {canvasMode === 'settings' ? (
          <SettingsCanvas />
        ) : canvasMode === 'history' ? (
          <HistoryCanvas />
        ) : canvasMode === 'monitor' ? (
          <HealthCanvas />
        ) : canvasMode === 'connections' ? (
          <ConnectionsCanvas />
        ) : (
          <EngineCanvas />
        )}
      </Suspense>

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
  const { tabId, kind, viewMode, hasResultOrError, running } = useActiveTabSelect((t) => ({
    tabId: t?.id,
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
  const isListen = kind === 'pg-listen';
  // Safe Run: the review replaces the result grid while one exists for this tab.
  const safeRunHere = useSession((s) => s.safeRun != null && s.safeRun.tabId === tabId) && isSqlTab;
  const hasResults = hasResultOrError || running || safeRunHere;
  const showEditor = isSqlTab && (!editorHidden || !hasResults);
  const showGrid = !isDiagram && !isListen && (!isSqlTab || hasResults);
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--wb-content)]">
      <TabStrip pane={pane} />
      {isDiagram && (
        <Suspense fallback={null}>
          <ErDiagramView />
        </Suspense>
      )}
      {isListen && tabId && (
        <Suspense fallback={null}>
          <PgListenView tabId={tabId} />
        </Suspense>
      )}
      {showEditor && <SqlCanvas expanded={!hasResults} />}
      {showEditor && hasResults && <EditorResizer />}
      {showEditor && <VariablesBar />}
      {isTableData && <FilterRow />}
      {safeRunHere && <SafeRunPanel />}
      {showGrid && !safeRunHere && isSqlTab && <ResultTabs />}
      {showGrid && !safeRunHere && <ResultBody />}
      {showGrid && !safeRunHere && <ResultFooter />}
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
          <Suspense fallback={null}>
            <ChartBody
              key={`${tab.id}-${tab.activeResultIndex}-${result.durationMs}`}
              result={result}
              tall
            />
          </Suspense>
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
