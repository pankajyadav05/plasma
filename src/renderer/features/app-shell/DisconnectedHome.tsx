import { Button } from '@/components/ui/button';
import { hostLabel, usePresenting } from '@/features/presentation/presentation';
import { ENGINE_ICON } from '@/lib/engine-meta';
import { pickAndOpenDataFiles } from '@/stores/data-files';
import { useSession } from '@/stores/session';
import type { ConnectionEngine, SavedConnection } from '@shared/protocol';
import { Bot, Cog, Copy, FileSpreadsheet, type LucideIcon, Pencil, Plus } from 'lucide-react';
import { Fragment } from 'react';
import { groupConnections } from '../connection-manager/connection-groups';
import { openSettingsSection } from '../settings/settings-nav';
import { WorkspaceHome } from '../workspace/WorkspaceHome';

const ENGINE_META: Record<ConnectionEngine, { label: string; icon: LucideIcon }> = {
  postgres: { label: 'Postgres', icon: ENGINE_ICON.postgres },
  redis: { label: 'Redis', icon: ENGINE_ICON.redis },
  opensearch: { label: 'OpenSearch', icon: ENGINE_ICON.opensearch },
  sqlite: { label: 'SQLite', icon: ENGINE_ICON.sqlite },
  mysql: { label: 'MySQL', icon: ENGINE_ICON.mysql },
  clickhouse: { label: 'ClickHouse', icon: ENGINE_ICON.clickhouse },
  duckdb: { label: 'DuckDB', icon: ENGINE_ICON.duckdb },
};

/**
 * Compose the secondary meta line for a saved-connection card. The
 * `database`/`user` fields carry different meanings per engine, so we
 * branch instead of dumping all four like the postgres-only flavor did.
 */
function metaLine(c: SavedConnection, presenting = false): string {
  const engine = c.engine ?? 'postgres';
  const hostPort = hostLabel(presenting, c.host, c.port);
  if (engine === 'redis') {
    return `${hostPort} · db ${c.database || '0'}${c.user ? ` · ${c.user}` : ''}`;
  }
  if (engine === 'opensearch') {
    return c.user ? `${hostPort} · ${c.user}` : hostPort;
  }
  if (engine === 'sqlite' || engine === 'duckdb') return presenting ? 'database file' : c.database;
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
  const duplicateSaved = useSession((s) => s.duplicateSaved);
  const openDialog = useSession((s) => s.openDialog);
  const connecting = useSession((s) => s.connectionState === 'connecting');
  const presenting = usePresenting();
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
            {groupConnections(savedConnections).map((g) => (
              <Fragment key={g.group ?? '__ungrouped'}>
                {g.group && (
                  <li className="px-1 pt-2 text-[11px] font-semibold text-[var(--wb-text-2)]">
                    {g.group}
                  </li>
                )}
                {g.items.map((c) => {
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
                            {metaLine(c, presenting)}
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
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void duplicateSaved(c.id);
                        }}
                        aria-label={`Duplicate ${c.name}`}
                        title="Duplicate"
                        className="grid w-10 shrink-0 cursor-pointer place-items-center text-[var(--wb-text-2)] opacity-0 transition-opacity duration-150 hover:text-[var(--wb-text)] focus-visible:opacity-100 group-hover/conn:opacity-100"
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          openSettingsSection('mcp');
                        }}
                        aria-label={`Allow AI tools on ${c.name}`}
                        title="Allow AI tools…"
                        data-testid={`allow-ai-tools-${c.id}`}
                        className="grid w-10 shrink-0 cursor-pointer place-items-center text-[var(--wb-text-2)] opacity-0 transition-opacity duration-150 hover:text-[var(--wb-text)] focus-visible:opacity-100 group-hover/conn:opacity-100"
                      >
                        <Bot className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  );
                })}
              </Fragment>
            ))}
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
        <div
          className="mt-6 flex items-center gap-3 rounded-[10px] border border-dashed border-[var(--wb-toolbar-group-edge)] p-3"
          data-testid="open-data-file"
        >
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[7px] bg-[var(--wb-control)]">
            <FileSpreadsheet className="h-4 w-4 text-[var(--icon-db)]" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-[var(--wb-text)]">Query a data file</div>
            <div className="text-[12px] text-[var(--wb-text-2)]">
              Drop a CSV, Excel, Parquet or JSON file here, or open one. DuckDB makes each file (and
              each Excel sheet) a table you can query with SQL.
            </div>
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={connecting}
            onClick={() => void pickAndOpenDataFiles()}
          >
            Open data file…
          </Button>
        </div>
        <WorkspaceHome />
      </div>
    </div>
  );
}
