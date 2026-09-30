import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/workbench';
import { OsSidebar } from '@/features/opensearch/OsSidebar';
import { RedisSidebar } from '@/features/redis/RedisSidebar';
import { cn } from '@/lib/cn';
import { useSession } from '@/stores/session';
import { type SidebarMode, useWorkbench } from '@/stores/workbench';
import { Circle, Copy, Pencil, Plus } from 'lucide-react';
import { groupConnections } from '../connection-manager/connection-groups';
import { EntityList } from './EntityList';
import { HistoryList } from './HistoryList';
import { SavedQueriesList } from './SavedQueriesList';

const MODES: Array<{ mode: SidebarMode; label: string }> = [
  { mode: 'items', label: 'Items' },
  { mode: 'queries', label: 'Queries' },
  { mode: 'history', label: 'History' },
];

/**
 * Left sidebar. For Postgres it has three modes, switched by the
 * segmented header (TablePlus layout):
 *
 *   Items    — schema entity browser (tables, views, matviews)
 *   Queries  — saved SQL snippets and saved table views
 *   History  — this connection's recent statements, by day
 *
 * Redis / OpenSearch keep their single engine-specific browser.
 */
export function Sidebar() {
  const activeConfig = useSession((s) => s.activeConfig);
  const engine = activeConfig?.engine ?? 'postgres';
  const mode = useWorkbench((s) => s.sidebarMode);

  return (
    <div className="flex h-full flex-col bg-[var(--wb-sidebar)] text-[var(--wb-text)]">
      {activeConfig && engine === 'postgres' && <SidebarModeSwitch />}
      <div className="min-h-0 flex-1 overflow-hidden">
        {!activeConfig ? (
          <SavedConnectionsList />
        ) : engine === 'redis' ? (
          <RedisSidebar />
        ) : engine === 'opensearch' ? (
          <OsSidebar />
        ) : mode === 'queries' ? (
          <SavedQueriesList />
        ) : mode === 'history' ? (
          <HistoryList />
        ) : (
          <EntityList />
        )}
      </div>
    </div>
  );
}

function SidebarModeSwitch() {
  const mode = useWorkbench((s) => s.sidebarMode);
  const setMode = useWorkbench((s) => s.setSidebarMode);
  return (
    <div className="shrink-0 px-2.5 pb-2 pt-2">
      <Segmented<SidebarMode>
        ariaLabel="Sidebar mode"
        variant="plain"
        stretch
        value={mode}
        onChange={setMode}
        options={MODES.map((m) => ({ value: m.mode, label: m.label }))}
      />
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
  const duplicateSaved = useSession((s) => s.duplicateSaved);
  const openDialog = useSession((s) => s.openDialog);

  const connecting = connectionState === 'connecting';

  return (
    <div className="flex h-full flex-col">
      <div className="px-3 py-2">
        <h2 className="text-[11px] font-semibold text-[var(--wb-text-2)]">Saved connections</h2>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {savedConnections.length === 0 ? (
          <div className="px-4 py-3 text-[13px] text-[var(--wb-text-2)]">none yet</div>
        ) : (
          groupConnections(savedConnections).map((g) => (
            <div key={g.group ?? '__ungrouped'}>
              {g.group && (
                <div className="px-4 pb-0.5 pt-2 text-[11px] font-semibold text-[var(--wb-text-2)]">
                  {g.group}
                </div>
              )}
              {g.items.map((c) => {
                const engine = c.engine ?? 'postgres';
                const engineLabel =
                  engine === 'redis'
                    ? 'Redis'
                    : engine === 'opensearch'
                      ? 'OpenSearch'
                      : 'Postgres';
                return (
                  <div
                    key={c.id}
                    className="group/row relative mx-2 flex h-6 items-stretch rounded-[5px] transition-colors hover:bg-[color-mix(in_srgb,var(--wb-text)_6%,transparent)]"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        if (!connecting) void connectSaved(c.id);
                      }}
                      disabled={connecting}
                      title={`Connect to ${c.host}:${c.port}${engine === 'postgres' ? `/${c.database}` : ''}`}
                      className={cn(
                        'flex min-w-0 flex-1 items-center gap-2 px-2 text-left text-[13px] transition-colors',
                        connecting
                          ? 'cursor-not-allowed text-[var(--wb-text-2)] opacity-60'
                          : 'cursor-pointer text-[var(--wb-text)]',
                      )}
                    >
                      <Circle className="h-2 w-2 shrink-0 text-[var(--wb-text-2)]" />
                      <span className="truncate">{c.name}</span>
                      <span className="ml-auto shrink-0 text-[11px] text-[var(--wb-text-3)]">
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
                      className="mr-0.5 h-5 w-5 self-center text-[var(--wb-text-2)] opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-visible:opacity-100"
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={(e) => {
                        e.stopPropagation();
                        void duplicateSaved(c.id);
                      }}
                      aria-label={`Duplicate ${c.name}`}
                      title="Duplicate"
                      className="mr-0.5 h-5 w-5 self-center text-[var(--wb-text-2)] opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-visible:opacity-100"
                    >
                      <Copy />
                    </Button>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>

      <div className="border-t border-[var(--wb-separator)] p-2.5">
        <Button variant="outline" size="sm" onClick={() => openDialog()} className="w-full">
          <Plus />
          Add connection
        </Button>
      </div>
    </div>
  );
}
