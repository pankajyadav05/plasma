import { useEffect } from "react";
import { useSession } from "@/stores/session";
import { TopBar } from "./TopBar";
import { StatusBar } from "./StatusBar";
import { SidebarResizer } from "./SidebarResizer";
import { Sidebar } from "@/features/sidebar/Sidebar";
import { TabStrip } from "@/features/editor/TabStrip";
import { EditorPane } from "@/features/editor/EditorPane";
import { ResultGrid } from "@/features/result-grid/ResultGrid";
import { PaginationBar } from "@/features/result-grid/PaginationBar";
import { ResultToolbar } from "@/features/result-grid/ResultToolbar";
import { ConnectionDialog } from "@/features/connection-manager/ConnectionDialog";
import { DeleteConfirmDialog } from "@/features/connection-manager/DeleteConfirmDialog";
import { CommandPalette } from "@/features/command-palette/CommandPalette";
import { SettingsSheet } from "@/features/settings/SettingsSheet";
import { HistorySheet } from "@/features/history/HistorySheet";

export function AppShell() {
  const dialogOpen = useSession((s) => s.dialogOpen);
  const sidebarCollapsed = useSession((s) => s.settings.sidebarCollapsed);
  const sidebarWidth = useSession((s) => s.settings.sidebarWidth);

  // Global shortcuts: ⌘J toggle editor, ⌘B toggle sidebar.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      const inInput = tag === "input" || tag === "textarea" || tag === "select";
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() === "j" && !inInput) {
        e.preventDefault();
        useSession.getState().toggleEditor();
      } else if (e.key.toLowerCase() === "b" && !inInput) {
        e.preventDefault();
        void useSession.getState().toggleSidebar();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  return (
    <>
      <div className="flex h-screen flex-col">
        <TopBar />

        <div className="flex min-h-0 flex-1">
          {/* Sidebar — width is user-controlled via SidebarResizer */}
          <aside
            className="relative shrink-0 overflow-hidden border-r bg-sidebar text-sidebar-foreground"
            style={{
              width: sidebarCollapsed ? 0 : sidebarWidth,
              transition: sidebarCollapsed ? "width 220ms cubic-bezier(0.16, 1, 0.3, 1)" : undefined,
            }}
            aria-hidden={sidebarCollapsed}
          >
            {/* Inner wrapper uses full sidebarWidth so content stays stable
                during collapse → 0 animation. During drag-resize the outer
                width changes live and the inner content follows naturally. */}
            <div className="h-full" style={{ width: sidebarWidth }}>
              <Sidebar />
            </div>
          </aside>

          {/* Resize handle — sits between aside and main */}
          <SidebarResizer />

          {/* Main = TabStrip + ResultToolbar + ResultGrid + PaginationBar */}
          <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
            <TabStrip />
            <ResultToolbar />
            <ResultGrid />
            <PaginationBar />
          </main>

          {/* Editor panel, right side */}
          <EditorPane />
        </div>

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
