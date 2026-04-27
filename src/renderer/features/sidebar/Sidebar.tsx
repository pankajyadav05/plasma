import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { kbd } from '@/lib/platform';
import { useSession } from '@/stores/session';
import { Circle, Command as CommandIcon, Pencil, Plus, Search } from 'lucide-react';
import { EntityList } from './EntityList';

const isMac = typeof window !== 'undefined' && window.plasma?.platform === 'darwin';

/**
 * Sidebar = single-purpose entity browser. Header strip is the ⌘K
 * palette pill; body is the EntityList (schema picker + filter +
 * flat list); footer is a small icon row for History / Settings /
 * Add connection.
 *
 * Connections moved to the topbar (breadcrumb). Mode switching killed
 * — SQL editor is summoned via ⌘J (right pane), schema browsing
 * happens directly in the entity list with the schema dropdown.
 */
export function Sidebar() {
  const togglePalette = useSession((s) => s.togglePalette);
  const activeConfig = useSession((s) => s.activeConfig);

  return (
    <div className="flex h-full flex-col">
      {/* ── ⌘K palette trigger ── */}
      <div className="shrink-0 px-3 py-2">
        <button
          type="button"
          onClick={togglePalette}
          title={`Command palette (${kbd('K')})`}
          className="group flex h-8 w-full cursor-pointer items-center gap-2 rounded-md border border-sidebar-border bg-background px-2.5 text-left text-sm text-muted-foreground transition-colors hover:border-foreground/40 hover:bg-accent/40"
        >
          <Search className="h-3.5 w-3.5" />
          <span className="flex-1 truncate font-display italic">Search</span>
          <span className="flex shrink-0 items-center gap-0.5 rounded-sm border border-border bg-muted/50 px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
            {isMac ? <CommandIcon className="h-2.5 w-2.5" /> : <span>Ctrl</span>}
            <span>K</span>
          </span>
        </button>
      </div>

      {/* ── Entity list (schema picker + search + filter + list) ── */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {activeConfig ? <EntityList /> : <SavedConnectionsList />}
      </div>
    </div>
  );
}

/**
 * Empty-state body — shown when there's no active connection. Lists
 * any vaulted connections (one-click reconnect), with edit/delete on
 * hover, plus an explicit "Add connection" CTA at the bottom.
 */
function SavedConnectionsList() {
  const savedConnections = useSession((s) => s.savedConnections);
  const connectionState = useSession((s) => s.connectionState);
  const connectSaved = useSession((s) => s.connectSaved);
  const editConnection = useSession((s) => s.editConnection);
  const openDialog = useSession((s) => s.openDialog);

  const connecting = connectionState === 'connecting';

  return (
    <div className="flex h-full flex-col">
      <div className="px-3 py-2">
        <h2 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Saved connections
        </h2>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {savedConnections.length === 0 ? (
          <div className="px-4 py-3 font-display text-sm italic text-muted-foreground">
            none yet
          </div>
        ) : (
          savedConnections.map((c) => (
            <div
              key={c.id}
              className="group/row relative mx-2 mb-0.5 flex h-8 items-stretch rounded-md transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              <button
                type="button"
                onClick={() => {
                  if (!connecting) void connectSaved(c.id);
                }}
                disabled={connecting}
                title={`Connect to ${c.host}:${c.port}/${c.database}`}
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-2 px-3 text-left text-sm transition-colors',
                  connecting
                    ? 'cursor-not-allowed text-muted-foreground opacity-60'
                    : 'cursor-pointer text-muted-foreground group-hover/row:text-sidebar-accent-foreground',
                )}
              >
                <Circle className="h-2 w-2 shrink-0 text-muted-foreground" />
                <span className="truncate">{c.name}</span>
              </button>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  void editConnection(c.id);
                }}
                aria-label={`Edit ${c.name}`}
                title="Edit (delete inside)"
                className="mr-1 h-6 w-6 self-center opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-visible:opacity-100"
              >
                <Pencil />
              </Button>
            </div>
          ))
        )}
      </div>

      <div className="border-t border-sidebar-border p-3">
        <Button variant="outline" size="sm" onClick={() => openDialog()} className="w-full">
          <Plus />
          Add connection
        </Button>
      </div>
    </div>
  );
}
