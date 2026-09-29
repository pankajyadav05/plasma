import { Button } from '@/components/ui/button';
import { useSession } from '@/stores/session';
import type { ConnectionEngine, SavedConnection } from '@shared/protocol';
import { Boxes, Cog, Database, Layers, Pencil, Plus } from 'lucide-react';

const ENGINE_META: Record<ConnectionEngine, { label: string; icon: typeof Database }> = {
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
  const setCanvasMode = useSession((s) => s.setCanvasMode);

  return (
    <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto bg-[var(--wb-content)]">
      <div className="w-full max-w-[560px] px-6 py-14">
        <div className="mb-6 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-[20px] font-semibold text-[var(--wb-text)]">Connections</h1>
            <p className="mt-0.5 text-[13px] text-[var(--wb-text-2)]">
              Pick a saved connection, or add a new one.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setCanvasMode('settings')}>
            <Cog />
            Settings
          </Button>
        </div>

        {savedConnections.length === 0 ? (
          <div className="rounded-[10px] border border-dashed border-[var(--wb-toolbar-group-edge)] p-8 text-center">
            <p className="mb-4 text-[15px] text-[var(--wb-text-2)]">No saved connections yet</p>
            <Button variant="primary" size="sm" onClick={() => openDialog()}>
              <Plus />
              Add your first connection
            </Button>
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {savedConnections.map((c) => {
              const engine = c.engine ?? 'postgres';
              const meta = ENGINE_META[engine];
              const Icon = meta.icon;
              return (
                <li
                  key={c.id}
                  className="group/conn flex items-stretch overflow-hidden rounded-[8px] bg-[var(--wb-sidebar)] shadow-[inset_0_0_0_1px_var(--wb-toolbar-group-edge)] transition-colors hover:bg-[var(--wb-control)]"
                >
                  <button
                    type="button"
                    disabled={connecting}
                    onClick={() => void connectSaved(c.id)}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-[8px] px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[7px] bg-[var(--wb-control)]">
                      <Icon className="h-4 w-4 text-[var(--icon-db)]" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[13px] font-medium text-[var(--wb-text)]">
                          {c.name}
                        </span>
                        <span className="shrink-0 rounded-[4px] bg-[var(--wb-control)] px-1.5 py-px text-[11px] text-[var(--wb-text-2)]">
                          {meta.label}
                        </span>
                      </div>
                      <div className="truncate font-mono text-[12px] text-[var(--wb-text-2)]">
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
                    className="grid w-10 shrink-0 cursor-pointer place-items-center text-[var(--wb-text-2)] opacity-0 transition-opacity duration-150 hover:text-[var(--wb-text)] focus-visible:opacity-100 group-hover/conn:opacity-100"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                </li>
              );
            })}
            <li>
              <Button
                variant="secondary"
                size="default"
                onClick={() => openDialog()}
                className="mt-3 w-full justify-center"
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
