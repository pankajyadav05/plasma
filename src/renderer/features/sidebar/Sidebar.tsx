import { Button } from '@/components/ui/button';
import { OsSidebar } from '@/features/opensearch/OsSidebar';
import { RedisSidebar } from '@/features/redis/RedisSidebar';
import { cn } from '@/lib/cn';
import { useSession } from '@/stores/session';
import { Circle, Pencil, Plus } from 'lucide-react';
import { EntityList } from './EntityList';

/**
 * Sidebar = single-purpose entity browser. Body is the engine-aware
 * browser (Postgres EntityList / Redis key tree / OpenSearch index list).
 * The ⌘K palette trigger lives in the IconRail bottom strip alongside
 * Settings — keeps the sidebar fully dedicated to data discovery.
 */
export function Sidebar() {
  const activeConfig = useSession((s) => s.activeConfig);
  const engine = activeConfig?.engine ?? 'postgres';

  return (
    <div className="flex h-full flex-col">
      {/* ── Engine-specific browser ── */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {!activeConfig ? (
          <SavedConnectionsList />
        ) : engine === 'redis' ? (
          <RedisSidebar />
        ) : engine === 'opensearch' ? (
          <OsSidebar />
        ) : (
          <EntityList />
        )}
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
          savedConnections.map((c) => {
            const engine = c.engine ?? 'postgres';
            const engineLabel =
              engine === 'redis' ? 'redis' : engine === 'opensearch' ? 'os' : 'pg';
            return (
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
                  title={`Connect to ${c.host}:${c.port}${engine === 'postgres' ? `/${c.database}` : ''}`}
                  className={cn(
                    'flex min-w-0 flex-1 items-center gap-2 px-3 text-left text-sm transition-colors',
                    connecting
                      ? 'cursor-not-allowed text-muted-foreground opacity-60'
                      : 'cursor-pointer text-muted-foreground group-hover/row:text-sidebar-accent-foreground',
                  )}
                >
                  <Circle className="h-2 w-2 shrink-0 text-muted-foreground" />
                  <span className="truncate">{c.name}</span>
                  <span className="ml-auto shrink-0 rounded-sm border border-border px-1 py-0 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                    {engineLabel}
                  </span>
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
            );
          })
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
