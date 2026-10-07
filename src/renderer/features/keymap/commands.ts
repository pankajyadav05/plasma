import {
  fileNameForTitle,
  pickSqlFile,
  rememberFileHandle,
  saveSqlFile,
} from '@/features/editor/sql-files';
import { useMigrationDialog } from '@/features/migration/migration-dialog-store';
import { useCompare } from '@/stores/compare';
import { pickAndOpenDataFiles, useDataFiles } from '@/stores/data-files';
import { isSplit, paneTabIds } from '@/stores/pane-state';
import { usePanes } from '@/stores/panes';
import { activeTab, useSession } from '@/stores/session';
import { editsOf } from '@/stores/session-pending-edits';
import { useWorkbench } from '@/stores/workbench';
import { useWorkspace } from '@/stores/workspace';
import { isDataFileSession } from '@shared/data-files';
import type { KeyId } from '@shared/keymap';
import type { ConnectionEngine } from '@shared/protocol';
import { keyeventPattern } from '@shared/redis-keyspace';
import { type EngineCapabilities, engineCaps } from '@shared/sql-dialect';

/**
 * One dispatcher for every app command, whatever triggered it: the
 * document key listener (AppShell), Monaco's passthrough for global
 * chords, the native menu (App.tsx) and the command palette. Keeping them
 * on one path means a chord, a menu item and a palette row can't drift.
 */
export type CommandId =
  | KeyId
  | 'toggleTheme'
  | 'newConnection'
  | 'openWorkspace'
  | 'openDataFile'
  | 'attachPostgres'
  | 'openConnectionString'
  | 'disconnect'
  | 'monitor'
  | 'exportJson'
  | 'backup'
  | 'sqliteBackup'
  | 'restore'
  | 'roles'
  | 'checkMigration'
  | 'dbSearch'
  | 'erDiagram'
  | 'compareResults'
  | 'pgListen'
  | 'redisKeyspace'
  | 'splitPane'
  | 'closePane';

/**
 * Commands of the SQL workbench (every SQL engine); the finer per-engine
 * restrictions are `COMMAND_CAPABILITY` below.
 */
const POSTGRES_ONLY: ReadonlySet<CommandId> = new Set<CommandId>([
  'runQuery',
  'runQueryAll',
  'safeRun',
  'cancelQuery',
  'history',
  'newTab',
  'toggleEditor',
  'formatSql',
  'askAi',
  'codegen',
  'notebook',
  'schemaDiff',
  'monitor',
  'backup',
  'restore',
  'roles',
  'checkMigration',
  'dbSearch',
  'erDiagram',
  'compareResults',
  'pgListen',
  'splitPane',
  'closePane',
  'nextPane',
  'prevPane',
  'exportCsv',
  'exportJson',
  'commitEdits',
  'saveFileAs',
  'openFile',
  'wordWrap',
  'fontBigger',
  'fontSmaller',
  'fontReset',
  'toggleComment',
]);

/** Extra capability a workbench command needs (anything absent needs only `sql`). */
const COMMAND_CAPABILITY: Partial<Record<CommandId, keyof EngineCapabilities>> = {
  monitor: 'activity',
  backup: 'pgBackup',
  restore: 'pgBackup',
  roles: 'roles',
  safeRun: 'safeRun',
  erDiagram: 'er',
  pgListen: 'pgExtras',
  dbSearch: 'pgExtras',
  schemaDiff: 'pgExtras',
  checkMigration: 'pgExtras',
};

/** Commands that need a live connection. */
const NEEDS_CONNECTION: ReadonlySet<CommandId> = new Set<CommandId>([
  ...POSTGRES_ONLY,
  'refresh',
  'toggleRightSidebar',
  'disconnect',
  'closeTab',
  'nextTab',
  'prevTab',
]);

/** Whether `id` makes sense for the connected engine (palette filtering, VF23). */
export function commandAvailable(
  id: CommandId,
  engine: ConnectionEngine | null,
  connected: boolean,
): boolean {
  if (NEEDS_CONNECTION.has(id) && !connected) return false;
  if (id === 'sqliteBackup') return connected && engineCaps(engine).fileBackup;
  if (id === 'redisKeyspace') return connected && engine === 'redis';
  if (id === 'attachPostgres') return connected && isDataFileSession(session().activeConfig);
  if (POSTGRES_ONLY.has(id)) {
    if (engine === null) return false;
    const caps = engineCaps(engine);
    if (!caps.sql) return false;
    const need = COMMAND_CAPABILITY[id];
    if (need && !caps[need]) return false;
  }
  return true;
}

const session = () => useSession.getState();

function engineOf(): ConnectionEngine | null {
  const s = session();
  if (s.connectionState !== 'connected') return null;
  return (s.activeConfig?.engine ?? 'postgres') as ConnectionEngine;
}

/** Tabs the strip shows (Redis / OpenSearch hide extra SQL tabs). */
export function visibleTabs() {
  const s = session();
  if (engineOf() === null || engineCaps(engineOf()).sql) {
    // With a split, ⌘1…9 and next / previous tab work within the focused pane.
    const panes = usePanes.getState();
    if (!isSplit(panes)) return s.tabs;
    const ids = new Set(
      paneTabIds(
        panes,
        s.tabs.map((t) => t.id),
        panes.focus,
      ),
    );
    return s.tabs.filter((t) => ids.has(t.id));
  }
  const overview = s.tabs.find((t) => t.kind === 'sql');
  return s.tabs.filter((t) => t.kind !== 'sql' || t.id === overview?.id);
}

export function selectTabAt(index: number): void {
  const tabs = visibleTabs();
  const target = index >= 8 ? tabs[tabs.length - 1] : tabs[index];
  if (target) session().setActiveTab(target.id);
}

function cycleTab(step: 1 | -1): void {
  const tabs = visibleTabs();
  if (tabs.length < 2) return;
  const idx = tabs.findIndex((t) => t.id === session().activeTabId);
  const next = tabs[(idx + step + tabs.length) % tabs.length];
  if (next) session().setActiveTab(next.id);
}

function exportEvent(kind: 'csv' | 'json') {
  window.dispatchEvent(new CustomEvent('plasma:export', { detail: { kind } }));
}

function setFontSize(next: (current: number) => number) {
  const s = session();
  const size = Math.max(10, Math.min(24, next(s.settings.editorFontSize)));
  if (size !== s.settings.editorFontSize) void s.updateSettings({ editorFontSize: size });
}

/** Save the active SQL tab to its .sql file (⌘S with nothing to commit, ⇧⌘S). */
export async function saveActiveSqlTab(saveAs: boolean): Promise<void> {
  const tab = activeTab(session());
  if (!tab || tab.kind !== 'sql') return;
  // A query opened from a team workspace saves back to its .plasma/ file.
  if (!saveAs && (await useWorkspace.getState().saveLinkedTab(tab.id))) return;
  const name = await saveSqlFile(
    tab.id,
    tab.sql,
    tab.fileName ?? fileNameForTitle(tab.title),
    saveAs,
  );
  if (name) session().markTabClean(tab.id, { title: name, fileName: name });
}

/** Open a .sql file into a new tab (⌘O). */
export async function openSqlFileInTab(): Promise<void> {
  const file = await pickSqlFile();
  if (!file) return;
  const id = session().openSqlInNewTab(file.text, {
    title: file.name,
    fileName: file.name,
    clean: true,
  });
  rememberFileHandle(id, file.handle);
}

/**
 * Run a command. Returns false when it doesn't apply right now (wrong
 * engine, disconnected), so the caller can let the key event through.
 */
export function runCommand(id: CommandId): boolean {
  const s = session();
  const engine = engineOf();
  if (!commandAvailable(id, engine, s.connectionState === 'connected')) return false;
  const wb = useWorkbench.getState();

  switch (id) {
    case 'palette':
      s.togglePalette();
      return true;
    case 'toggleAi':
      s.setRightPanelMode(s.rightPanelMode === 'ai' ? null : 'ai');
      return true;
    case 'cheatSheet':
      wb.setOverlay(wb.overlay === 'cheatSheet' ? null : 'cheatSheet');
      return true;
    case 'toggleSidebar':
      void s.toggleSidebar();
      return true;
    case 'toggleEditor':
      s.toggleEditor();
      return true;
    case 'presentationMode':
      void s.updateSettings({ presentationMode: !s.settings.presentationMode });
      return true;
    case 'pgListen':
      s.setCanvasMode('database');
      s.openPgListen();
      return true;
    case 'redisKeyspace':
      s.setCanvasMode('database');
      s.openRedisPubsub(keyeventPattern(s.redisDb ?? 0), true);
      return true;
    case 'toggleRightSidebar':
      if (s.canvasMode !== 'database') return false;
      s.setRightPanelMode(s.rightPanelMode ? null : 'details');
      return true;
    case 'runQuery':
      void s.runQuery();
      return true;
    case 'runQueryAll':
      void s.runQuery({ all: true });
      return true;
    case 'safeRun':
      void s.runSafeRun();
      return true;
    case 'cancelQuery':
      void s.cancelQuery();
      return true;
    case 'history':
      s.setCanvasMode(s.canvasMode === 'history' ? 'database' : 'history');
      return true;
    case 'settings':
      s.setCanvasMode(s.canvasMode === 'settings' ? 'database' : 'settings');
      return true;
    case 'monitor':
      s.setCanvasMode(s.canvasMode === 'monitor' ? 'database' : 'monitor');
      return true;
    case 'newTab':
      s.addTab();
      return true;
    case 'closeTab':
      s.requestCloseTabs([s.activeTabId]);
      return true;
    case 'nextTab':
      cycleTab(1);
      return true;
    case 'prevTab':
      cycleTab(-1);
      return true;
    case 'selectTab':
      selectTabAt(0);
      return true;
    case 'exportCsv':
      exportEvent('csv');
      return true;
    case 'exportJson':
      exportEvent('json');
      return true;
    case 'formatSql':
      void s.formatActiveSql();
      return true;
    case 'askAi': {
      const tab = activeTab(s);
      if (!tab || tab.kind !== 'sql' || !tab.sql.trim()) {
        s.setRightPanelMode('ai');
        return true;
      }
      void s.aiAsk(`Explain or improve this SQL:\n\n\`\`\`sql\n${tab.sql}\n\`\`\``);
      return true;
    }
    case 'codegen':
    case 'notebook':
    case 'schemaDiff':
    case 'backup':
    case 'restore':
    case 'roles':
      wb.setOverlay(id);
      return true;
    case 'checkMigration':
      useMigrationDialog.getState().show();
      return true;
    case 'sqliteBackup':
      wb.setOverlay(id);
      return true;
    case 'dbSearch':
      wb.setOverlay(wb.overlay === 'dbSearch' ? null : 'dbSearch');
      return true;
    case 'compareResults': {
      s.setCanvasMode('database');
      useCompare.getState().open();
      return true;
    }
    case 'erDiagram': {
      // The schema of the active table tab, else the first user schema.
      const tab = activeTab(s);
      const schema =
        (tab?.kind === 'table' ? tab.tableSchema : undefined) ??
        s.activeTable?.schema ??
        s.schema?.schemas.find((x) => x.name === 'public')?.name ??
        s.schema?.schemas[0]?.name ??
        'public';
      s.setCanvasMode('database');
      s.openErDiagram({ schema });
      return true;
    }
    case 'splitPane':
      usePanes.getState().splitRight();
      return true;
    case 'closePane':
      if (!isSplit(usePanes.getState())) return false;
      usePanes.getState().closePane();
      return true;
    case 'nextPane':
    case 'prevPane':
      if (!isSplit(usePanes.getState())) return false;
      usePanes.getState().switchPane(id === 'nextPane' ? 1 : -1);
      return true;
    case 'commitEdits':
      // R-01: ⌘S acts on the ACTIVE tab only. In a SQL tab it saves the
      // file, whatever other tabs have staged; in a table tab it commits
      // that tab's own edits. Failures land in `pendingEditsError`.
      if (activeTab(s)?.kind === 'sql') {
        void saveActiveSqlTab(false);
        return true;
      }
      if (editsOf(s.pendingEditsByTab, s.activeTabId).length > 0) {
        void s.commitPendingEdits({ tabId: s.activeTabId }).catch(() => undefined);
        return true;
      }
      return false;
    case 'saveFileAs':
      if (activeTab(s)?.kind !== 'sql') return false;
      void saveActiveSqlTab(true);
      return true;
    case 'openFile':
      void openSqlFileInTab();
      return true;
    case 'refresh': {
      const tab = activeTab(s);
      if (engine === 'redis') {
        void s.refreshRedisOverview();
        void s.scanRedisKeys({ cursor: '0' });
      } else if (engine === 'opensearch') {
        void s.refreshOsOverview();
      } else if (tab?.kind === 'table') {
        void s.refreshTable();
      } else {
        void s.refreshSchema();
      }
      return true;
    }
    case 'wordWrap':
      wb.setWordWrap(!wb.wordWrap);
      return true;
    case 'fontBigger':
      setFontSize((n) => n + 1);
      return true;
    case 'fontSmaller':
      setFontSize((n) => n - 1);
      return true;
    case 'fontReset':
      setFontSize(() => 13);
      return true;
    case 'toggleTheme':
      void s.toggleTheme();
      return true;
    case 'newConnection':
      s.openDialog();
      return true;
    case 'openWorkspace':
      void useWorkspace.getState().openDialog();
      return true;
    case 'openDataFile':
      void pickAndOpenDataFiles();
      return true;
    case 'attachPostgres':
      useDataFiles.setState({ attachOpen: true });
      return true;
    case 'openConnectionString':
      useWorkspace.setState({ connectionStringOpen: true });
      return true;
    case 'disconnect':
      void s.disconnect();
      return true;
    default:
      // Documentation-only entries (grid keys etc.) and Monaco's own
      // comment toggle are handled where they live.
      return false;
  }
}
