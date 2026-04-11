import { Clock, Command as CommandIcon, Moon, PanelLeft, PanelLeftClose, Settings, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useSession } from "@/stores/session";

export function TopBar() {
  const activeConfig = useSession((s) => s.activeConfig);
  const connectionState = useSession((s) => s.connectionState);
  const openDialog = useSession((s) => s.openDialog);
  const editConnection = useSession((s) => s.editConnection);
  const togglePalette = useSession((s) => s.togglePalette);
  const setSettingsOpen = useSession((s) => s.setSettingsOpen);
  const setHistoryOpen = useSession((s) => s.setHistoryOpen);
  const loadHistory = useSession((s) => s.loadHistory);
  const toggleTheme = useSession((s) => s.toggleTheme);
  const toggleSidebar = useSession((s) => s.toggleSidebar);
  const sidebarCollapsed = useSession((s) => s.settings.sidebarCollapsed);
  const theme = useSession((s) => s.settings.theme);

  const dotClass =
    connectionState === "connected"
      ? "bg-accent"
      : connectionState === "connecting"
        ? "bg-type-json animate-pulse"
        : connectionState === "error"
          ? "bg-accent"
          : "bg-ink-disabled";

  return (
    <header className="drag topbar-pad relative z-20 flex h-12 items-center gap-3 bg-paper">
      <div className="no-drag flex items-center">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void toggleSidebar()}
          aria-label={sidebarCollapsed ? "Show sidebar (⌘B)" : "Hide sidebar (⌘B)"}
          title={sidebarCollapsed ? "Show sidebar (⌘B)" : "Hide sidebar (⌘B)"}
        >
          {sidebarCollapsed ? <PanelLeft /> : <PanelLeftClose />}
        </Button>
      </div>

      <Separator orientation="vertical" className="h-5" />

      {/*
        Wordmark — rendered as live HTML text (not SVG img) so the
        Newsreader font loaded by the app handles the kerning. The
        oxblood signature stroke is drawn as a pseudo-element exactly
        matching the text box width, so it's always flush with "Plasma"
        regardless of which font (Newsreader / Georgia fallback) is
        actually rendering.
      */}
      <h1 className="flex items-baseline gap-3 leading-none" aria-label="Plasma">
        <span
          className={
            "relative font-display text-[22px] italic text-ink pb-[3px] " +
            "after:absolute after:inset-x-0 after:bottom-0 after:h-[2px] after:bg-accent after:content-['']"
          }
          style={{ fontWeight: 500 }}
        >
          Plasma
        </span>
        <span className="hidden font-display text-sm italic text-ink-muted md:inline">— a quiet place for queries</span>
      </h1>

      <Separator orientation="vertical" className="h-5" />

      {activeConfig ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void editConnection(activeConfig.id)}
          title="Edit this connection"
          className="no-drag -ml-1 h-8 gap-2.5 px-2 font-mono text-sm normal-case tracking-normal text-ink-2 hover:bg-transparent hover:text-ink"
        >
          <span aria-label={connectionState} className={`inline-block h-2 w-2 rounded-none ${dotClass}`} />
          <span className="max-w-[180px] truncate">{activeConfig.name}</span>
          <span className="text-ink-disabled">/</span>
          <span className="max-w-[140px] truncate">{activeConfig.database}</span>
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => openDialog()}
          className="no-drag -ml-1 h-8 gap-2 px-2 font-display text-sm italic normal-case tracking-normal text-ink-muted hover:bg-transparent hover:text-accent"
        >
          <span className="inline-block h-2 w-2 rounded-none bg-ink-disabled" />
          click to connect…
        </Button>
      )}

      <div className="flex-1" />

      <div className="no-drag flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Query history (⌘H)"
          title="Query history (⌘H)"
          onClick={() => {
            setHistoryOpen(true);
            void loadHistory();
          }}
        >
          <Clock />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={theme === "paper" ? "Dark theme" : "Light theme"}
          title={theme === "paper" ? "Dark theme" : "Light theme"}
          onClick={() => void toggleTheme()}
        >
          {theme === "paper" ? <Moon /> : <Sun />}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Settings"
          title="Settings"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings />
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={togglePalette}
          title="Command palette (⌘K)"
          className="ml-2 h-7 gap-1.5 px-2.5 font-mono text-xs normal-case tracking-[0.04em] text-ink"
        >
          <CommandIcon className="h-3 w-3" />
          <span>K</span>
        </Button>
      </div>
    </header>
  );
}
