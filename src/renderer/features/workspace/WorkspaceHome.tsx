import { Button } from '@/components/ui/button';
import { ENGINE_ICON } from '@/lib/engine-meta';
import { useSession } from '@/stores/session';
import { useWorkspace } from '@/stores/workspace';
import { FolderOpen, Users, X } from 'lucide-react';

/**
 * Home screen block for team workspaces: the open workspace's connection
 * profiles, or — when none is open — the recent ones and an "Open workspace
 * folder…" button.
 */
export function WorkspaceHome() {
  const snapshot = useWorkspace((s) => s.snapshot);
  const recents = useWorkspace((s) => s.recents);
  const openDialog = useWorkspace((s) => s.openDialog);
  const openRecent = useWorkspace((s) => s.openRecent);
  const forgetRecent = useWorkspace((s) => s.forgetRecent);
  const connectProfile = useWorkspace((s) => s.connectProfile);
  const close = useWorkspace((s) => s.close);
  const connecting = useSession((s) => s.connectionState === 'connecting');

  return (
    <section className="mt-8" aria-label="Team workspace" data-testid="workspace-home">
      <div className="mb-2 flex items-center gap-2">
        <Users className="h-3.5 w-3.5 text-[var(--wb-text-2)]" />
        <h2 className="text-[13px] font-semibold text-[var(--wb-text)]">
          {snapshot ? `Workspace · ${snapshot.name}` : 'Team workspace'}
        </h2>
        <div className="flex-1" />
        {snapshot ? (
          <Button variant="ghost" size="sm" onClick={() => void close()}>
            <X />
            Close
          </Button>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => void openDialog()}>
            <FolderOpen />
            Open workspace folder…
          </Button>
        )}
      </div>

      {snapshot ? (
        <>
          {snapshot.problems.length > 0 && (
            <p className="mb-2 text-[12px] text-[var(--wb-text-2)]">{snapshot.problems[0]}</p>
          )}
          {snapshot.profiles.length === 0 ? (
            <p className="text-[12px] text-[var(--wb-text-3)]">
              No connections in .plasma/connections.json. {snapshot.queries.length} shared quer
              {snapshot.queries.length === 1 ? 'y' : 'ies'}.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {snapshot.profiles.map((p) => {
                const Icon = ENGINE_ICON[p.engine];
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      disabled={connecting}
                      onClick={() => void connectProfile(p.id)}
                      className="flex w-full cursor-pointer items-center gap-3 rounded-[8px] bg-[var(--wb-sidebar)] px-3 py-2 text-left shadow-[inset_0_0_0_1px_var(--wb-toolbar-group-edge)] transition-colors hover:bg-[var(--wb-control)] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <Icon className="h-4 w-4 shrink-0 text-[var(--icon-db)]" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-[var(--wb-text)]">
                          {p.name}
                          {p.tag ? ` · ${p.tag}` : ''}
                        </span>
                        <span className="block truncate font-mono text-[12px] text-[var(--wb-text-2)]">
                          {p.error ?? p.summary}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : recents.length > 0 ? (
        <ul className="flex flex-col gap-1">
          <li className="px-1 text-[11px] font-semibold text-[var(--wb-text-2)]">
            Recent workspaces
          </li>
          {recents.map((r) => (
            <li
              key={r.path}
              className="group/recent flex items-center rounded-[6px] hover:bg-[var(--wb-control)]"
            >
              <button
                type="button"
                onClick={() => void openRecent(r.path)}
                className="flex min-w-0 flex-1 cursor-pointer items-baseline gap-2 px-2 py-1.5 text-left"
                title={r.path}
              >
                <span className="text-[13px] text-[var(--wb-text)]">{r.name}</span>
                <span className="truncate font-mono text-[11px] text-[var(--wb-text-3)]">
                  {r.path}
                </span>
              </button>
              <button
                type="button"
                onClick={() => void forgetRecent(r.path)}
                aria-label={`Forget ${r.name}`}
                className="mr-1 grid h-6 w-6 shrink-0 cursor-pointer place-items-center text-[var(--wb-text-3)] opacity-0 hover:text-[var(--wb-text)] focus-visible:opacity-100 group-hover/recent:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12px] text-[var(--wb-text-3)]">
          Open a folder with a .plasma/ directory to share connections, queries and snippets through
          git.
        </p>
      )}
    </section>
  );
}
