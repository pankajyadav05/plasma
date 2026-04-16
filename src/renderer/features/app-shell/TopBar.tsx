import { Command as CommandIcon, Lock, PanelLeft, PanelLeftClose, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/cn";
import { kbd } from "@/lib/platform";
import { useSession } from "@/stores/session";
import { BrandWordmark } from "./BrandWordmark";
import { WindowControls } from "./WindowControls";

const isMac = window.plasma?.platform === "darwin";

export function TopBar() {
  const activeConfig = useSession((s) => s.activeConfig);
  const connectionState = useSession((s) => s.connectionState);
  const openDialog = useSession((s) => s.openDialog);
  const editConnection = useSession((s) => s.editConnection);
  const togglePalette = useSession((s) => s.togglePalette);
  const toggleSidebar = useSession((s) => s.toggleSidebar);
  const sidebarCollapsed = useSession((s) => s.settings.sidebarCollapsed);
  const editMode = useSession((s) => s.editMode);
  const toggleEditMode = useSession((s) => s.toggleEditMode);

  const overlayOpen = useSession(
    (s) => s.dialogOpen || s.paletteOpen || s.settingsOpen || s.historyOpen || s.deleteConfirmConnectionId !== null,
  );

  const dotClass =
    connectionState === "connected"
      ? "bg-primary"
      : connectionState === "connecting"
        ? "bg-primary animate-pulse"
        : connectionState === "error"
          ? "bg-destructive"
          : "bg-muted-foreground";

  return (
    <header
      className={cn(
        "topbar-pad relative z-20 flex h-12 items-center gap-3 border-b bg-background",
        overlayOpen ? "pointer-events-none" : "drag",
      )}
    >
      <div className="no-drag flex items-center">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void toggleSidebar()}
          aria-label={sidebarCollapsed ? `Show sidebar (${kbd("B")})` : `Hide sidebar (${kbd("B")})`}
          title={sidebarCollapsed ? `Show sidebar (${kbd("B")})` : `Hide sidebar (${kbd("B")})`}
        >
          {sidebarCollapsed ? <PanelLeft /> : <PanelLeftClose />}
        </Button>
      </div>

      <Separator orientation="vertical" className="h-5" />

      <BrandWordmark className="h-8" />

      <Separator orientation="vertical" className="h-5" />

      {activeConfig ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void editConnection(activeConfig.id)}
          title="Edit this connection"
          className="no-drag h-8 gap-2 px-2 text-sm font-normal text-muted-foreground"
        >
          <span aria-label={connectionState} className={cn("inline-block h-2 w-2 rounded-full", dotClass)} />
          <span className="max-w-[180px] truncate text-foreground">{activeConfig.name}</span>
          <span className="text-muted-foreground/60">/</span>
          <span className="max-w-[140px] truncate">{activeConfig.database}</span>
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => openDialog()}
          className="no-drag h-8 gap-2 px-2 text-sm font-normal text-muted-foreground"
        >
          <span className="inline-block h-2 w-2 rounded-full bg-muted-foreground" />
          Connect to a database
        </Button>
      )}

      <div className="flex-1" />

      {activeConfig && (
        <Button
          variant={editMode ? "primary" : "outline"}
          size="xs"
          onClick={toggleEditMode}
          title={editMode ? "Writes enabled — click to lock" : "Read-only — click to enable writes"}
          className="no-drag"
        >
          {editMode ? <Pencil /> : <Lock />}
          {editMode ? "Edit mode" : "Read only"}
        </Button>
      )}

      <div className="no-drag flex items-center">
        <Button
          variant="outline"
          size="sm"
          onClick={togglePalette}
          title={`Command palette (${kbd("K")}) — history, theme, settings`}
          className="ml-2 h-8 gap-1.5 px-2.5 text-xs"
        >
          {isMac ? (
            <>
              <CommandIcon className="h-3 w-3" />
              <span>K</span>
            </>
          ) : (
            <>
              <span className="text-muted-foreground">Ctrl</span>
              <span>K</span>
            </>
          )}
        </Button>
      </div>

      {!isMac && <WindowControls />}
    </header>
  );
}
