import { Button } from '@/components/ui/button';
import { useSession } from '@/stores/session';
import type { ConnectionEngine, SavedConnection } from '@shared/protocol';
import { Boxes, Database, Layers, Pencil, Plus } from 'lucide-react';

const ENGINE_META: Record<
  ConnectionEngine,
  { label: string; icon: typeof Database }
> = {
  postgres: { label: 'Postgres', icon: Database },
  redis: { label: 'Redis', icon: Layers },
  opensearch: { label: 'OpenSearch', icon: Boxes },
};

/**
 * Compose the secondary meta line for a saved-connection card. The
 * `database`/`user` fields carry different meanings per engine, so we
 * branch instead of dumping all four like the postgres-only flavor did.
 */
function metaLine(c: SavedConnection): string {
  const engine = c.engine ?? 'postgres';
  const hostPort = `${c.host}:${c.port}`;
  if (engine === 'redis') {
    return `${hostPort} · db ${c.database || '0'}${c.user ? ` · ${c.user}` : ''}`;
  }
  if (engine === 'opensearch') {
    return c.user ? `${hostPort} · ${c.user}` : hostPort;
  }
  return `${hostPort} · ${c.database} · ${c.user}`;
}

/**
 * Full-window landing when no connection is active. Centered card
 * stack — saved-connection picker on top, "Add another" CTA below.
 * Renders without the icon rail / sidebar / tab strip so it reads
 * as a real onboarding screen, not a nested empty state.
 */
export function DisconnectedHome() {
  const savedConnections = useSession((s) => s.savedConnections);
  const connectSaved = useSession((s) => s.connectSaved);
  const editConnection = useSession((s) => s.editConnection);
  const openDialog = useSession((s) => s.openDialog);
  const connecting = useSession((s) => s.connectionState === 'connecting');

  return (
    <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto bg-card">
      <div className="w-full max-w-[640px] px-6 py-16">
        <h1 className="mb-1 font-display text-3xl italic text-foreground">
          A quiet place for queries.
        </h1>
        <p className="mb-8 font-display text-sm italic text-muted-foreground">
          Pick a saved connection — or add a new one.
        </p>

        {savedConnections.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-8 text-center">
            <p className="mb-4 font-display text-base italic text-muted-foreground">
              no saved connections yet
            </p>
            <Button variant="primary" size="sm" onClick={() => openDialog()}>
              <Plus />
              Add your first connection
            </Button>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {savedConnections.map((c) => {
              const engine = c.engine ?? 'postgres';
              const meta = ENGINE_META[engine];
              const Icon = meta.icon;
              return (
              <li
                key={c.id}
                className="group/conn flex items-stretch overflow-hidden rounded-md border border-border bg-background transition-colors hover:border-foreground/40"
              >
                <button
                  type="button"
                  disabled={connecting}
                  onClick={() => void connectSaved(c.id)}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 px-4 py-3 text-left disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-sm border border-border bg-muted">
                    <Icon className="h-4 w-4 text-muted-foreground" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {c.name}
                      </span>
                      <span className="shrink-0 rounded-sm border border-border px-1.5 py-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                        {meta.label}
                      </span>
                    </div>
                    <div className="truncate font-mono text-[11px] text-muted-foreground">
                      {metaLine(c)}
                    </div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void editConnection(c.id);
                  }}
                  aria-label={`Edit ${c.name}`}
                  title="Edit (delete inside)"
                  className="grid w-10 shrink-0 cursor-pointer place-items-center border-l border-border text-muted-foreground opacity-0 transition-opacity duration-150 hover:text-foreground focus-visible:opacity-100 group-hover/conn:opacity-100"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              </li>
              );
            })}
            <li>
              <Button
                variant="outline"
                size="default"
                onClick={() => openDialog()}
                className="mt-4 w-full justify-center"
              >
                <Plus />
                Add another connection
              </Button>
            </li>
          </ul>
        )}
      </div>
    </div>
  );
}
