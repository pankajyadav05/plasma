import { CommandPalette } from '@/features/command-palette/CommandPalette';
import { ConnectionDialog } from '@/features/connection-manager/ConnectionDialog';
import { DeleteConfirmDialog } from '@/features/connection-manager/DeleteConfirmDialog';
import { SqlCanvas } from '@/features/editor/SqlCanvas';
import { TabStrip } from '@/features/editor/TabStrip';
import { HistoryCanvas } from '@/features/history/HistoryCanvas';
import { HistorySheet } from '@/features/history/HistorySheet';
import { FilterRow } from '@/features/result-grid/FilterRow';
import { PaginationBar } from '@/features/result-grid/PaginationBar';
import { ResultGrid } from '@/features/result-grid/ResultGrid';
import { ResultToolbar } from '@/features/result-grid/ResultToolbar';
import { RightRail } from '@/features/right-rail/RightRail';
import { SettingsCanvas } from '@/features/settings/SettingsCanvas';
import { SettingsSheet } from '@/features/settings/SettingsSheet';
import { Sidebar } from '@/features/sidebar/Sidebar';
import { useActiveTab, useSession } from '@/stores/session';
import { useEffect } from 'react';
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

  // Global shortcuts: ⌘J toggle editor, ⌘B toggle sidebar, Esc closes
  // settings/history full-window canvases back to database.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? '').toLowerCase();
      const inInput = tag === 'input' || tag === 'textarea' || tag === 'select';
      if (e.key === 'Escape' && !inInput) {
        const m = useSession.getState().canvasMode;
        if (m === 'settings' || m === 'history') {
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
    </>
  );
}

function ConnectedShell() {
  const sidebarCollapsed = useSession((s) => s.settings.sidebarCollapsed);
  const sidebarWidth = useSession((s) => s.settings.sidebarWidth);
  const canvasMode = useSession((s) => s.canvasMode);

  // Settings + History are full-page replacements for the sidebar +
  // main area, but the IconRail (left) and RightRail (right) stay
  // visible so the user never loses navigation context.
  const fullPage = canvasMode === 'settings' || canvasMode === 'history';

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
      ) : canvasMode === 'sql' ? (
        <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
          <TabStrip />
          <SqlCanvas />
          <ResultGrid />
          <PaginationBar />
        </main>
      ) : (
        <DatabaseCanvas />
      )}

      {/* RightRail only makes sense in the Database canvas — Query /
          Role / RLS are all scoped to a table or active query. Keep
          it hidden in SQL / Settings / History modes. */}
      {canvasMode === 'database' && <RightRail />}
    </div>
  );
}

function DatabaseCanvas() {
  const tab = useActiveTab();
  const showFilterRow = tab?.kind === 'table' && tab.viewMode !== 'definition';
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <TabStrip />
      {showFilterRow && <FilterRow />}
      <ResultToolbar />
      <ResultGrid />
      <PaginationBar />
    </main>
  );
}
