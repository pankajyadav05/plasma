import { Button } from '@/components/ui/button';
import { hasCellContent, loadDraft, saveDraft } from '@/features/notebook/notebook-storage';
import { cn } from '@/lib/cn';
import { ENGINE_ICON } from '@/lib/engine-meta';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import { useWorkbench } from '@/stores/workbench';
import { useWorkspace } from '@/stores/workspace';
import { type QueryTreeNode, buildQueryTree } from '@shared/workspace';
import {
  BookText,
  ChevronDown,
  ChevronRight,
  File,
  FilePlus2,
  Folder,
  FolderOpen,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { sidebarRowClass } from '../sidebar/sidebar-parts';

const TAG_COLOR = {
  local: 'var(--status-local)',
  dev: 'var(--status-dev)',
  staging: 'var(--status-staging)',
  prod: 'var(--status-prod)',
} as const;

/**
 * Sidebar "Workspace" section: the open team folder's name, its connection
 * profiles and its saved-query tree. Click a profile to connect (asks for the
 * password once); click a query to open it in a new tab.
 */
export function WorkspaceSection() {
  const snapshot = useWorkspace((s) => s.snapshot);
  const [open, setOpen] = useState(true);
  const connecting = useSession((s) => s.connectionState === 'connecting');
  const activeId = useSession((s) => s.activeConfig?.id);
  const connectProfile = useWorkspace((s) => s.connectProfile);
  const openQuery = useWorkspace((s) => s.openQuery);
  const close = useWorkspace((s) => s.close);
  const tree = useMemo(() => buildQueryTree(snapshot?.queries ?? []), [snapshot?.queries]);
  const activeTab = useSession((s) => s.tabs.find((t) => t.id === s.activeTabId));
  const canSaveHere = activeTab?.kind === 'sql' && activeTab.sql.trim().length > 0;

  if (!snapshot) return null;
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <section
      aria-label="Workspace"
      data-testid="workspace-section"
      className="flex max-h-[48%] min-h-0 shrink-0 flex-col border-t border-[var(--wb-separator)]"
    >
      <div className="flex h-7 shrink-0 items-center gap-1 px-2">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left"
          aria-expanded={open}
          title={snapshot.root}
        >
          <Chevron className="h-3 w-3 shrink-0 text-[var(--wb-text-2)]" />
          <Users className="h-3 w-3 shrink-0 text-[var(--wb-text-2)]" />
          <span className="text-[11px] font-semibold text-[var(--wb-text-2)]">Workspace</span>
          <span className="truncate text-[12px] text-[var(--wb-text)]">{snapshot.name}</span>
        </button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="h-5 w-5"
          disabled={!canSaveHere}
          onClick={() =>
            activeTab && useWorkspace.setState({ saveDialog: { tabId: activeTab.id } })
          }
          aria-label="Save current query to workspace"
          title="Save current query to workspace"
        >
          <FilePlus2 />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="h-5 w-5"
          onClick={() => void close()}
          aria-label="Close workspace"
          title="Close workspace"
        >
          <X />
        </Button>
      </div>

      {open && (
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          {snapshot.problems.length > 0 && (
            <div className="mx-3 mb-1 rounded-[5px] bg-[color-mix(in_srgb,var(--status-staging)_14%,transparent)] px-2 py-1 text-[11px] text-[var(--wb-text-2)]">
              {snapshot.problems.slice(0, 3).map((p) => (
                <div key={p}>{p}</div>
              ))}
            </div>
          )}

          <SubHeading>Connections</SubHeading>
          {snapshot.profiles.length === 0 ? (
            <Hint>No .plasma/connections.json yet</Hint>
          ) : (
            snapshot.profiles.map((p) => {
              const Icon = ENGINE_ICON[p.engine];
              const connectedHere =
                activeId?.endsWith(`:${p.id}`) === true && activeId.startsWith('ws:');
              return (
                <button
                  key={p.id}
                  type="button"
                  disabled={connecting}
                  onClick={() => void connectProfile(p.id)}
                  title={p.error ?? (p.summary || p.name)}
                  className={cn(
                    sidebarRowClass(connectedHere),
                    'w-[calc(100%-1rem)] cursor-pointer gap-2 px-2 text-left',
                  )}
                >
                  <Icon className="h-3 w-3 shrink-0 text-[var(--wb-text-2)]" />
                  <span
                    className={cn('truncate', p.error && 'text-[var(--wb-text-3)] line-through')}
                  >
                    {p.name}
                  </span>
                  {p.tag && (
                    <span
                      className="shrink-0 rounded-[3px] px-1 text-[10px] uppercase"
                      style={{ color: TAG_COLOR[p.tag] }}
                    >
                      {p.tag}
                    </span>
                  )}
                  {p.readOnly && (
                    <span className="shrink-0 text-[10px] text-[var(--wb-text-3)]">read-only</span>
                  )}
                  {p.needsPassword && (
                    <span className="ml-auto shrink-0 text-[10px] text-[var(--wb-text-3)]">
                      password
                    </span>
                  )}
                </button>
              );
            })
          )}

          <SubHeading>Queries</SubHeading>
          {snapshot.queries.length === 0 ? (
            <Hint>Save a query here to share it with the team</Hint>
          ) : (
            <QueryNode node={tree} depth={0} onOpen={openQuery} />
          )}

          {snapshot.notebooks.length > 0 && (
            <>
              <SubHeading>Notebooks</SubHeading>
              {snapshot.notebooks.map((n) => (
                <button
                  key={n.file}
                  type="button"
                  onClick={() => void openWorkspaceNotebook(n.file)}
                  className={cn(
                    sidebarRowClass(),
                    'w-[calc(100%-1rem)] cursor-pointer gap-2 px-2 text-left',
                  )}
                  title={`${n.cellCount} cells`}
                >
                  <BookText className="h-3 w-3 shrink-0 text-[var(--wb-text-2)]" />
                  <span className="truncate">{n.name}</span>
                </button>
              ))}
            </>
          )}

          {snapshot.snippets.length > 0 && (
            <>
              <SubHeading>Snippets</SubHeading>
              <Hint>
                {snapshot.snippets.length} shared snippet{snapshot.snippets.length === 1 ? '' : 's'}{' '}
                — type a prefix in the editor (
                {snapshot.snippets
                  .slice(0, 3)
                  .map((s) => s.prefix)
                  .join(', ')}
                {snapshot.snippets.length > 3 ? ', …' : ''})
              </Hint>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 pb-0.5 pt-1.5 text-[11px] font-semibold text-[var(--wb-text-2)]">
      {children}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-1 text-[11px] text-[var(--wb-text-3)]">{children}</div>;
}

function QueryNode({
  node,
  depth,
  onOpen,
}: {
  node: QueryTreeNode;
  depth: number;
  onOpen: (path: string) => void;
}) {
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const deleteQuery = useWorkspace((s) => s.deleteQuery);
  const [confirm, setConfirm] = useState<string | null>(null);
  const pad = { paddingLeft: 8 + depth * 12 };
  return (
    <>
      {node.folders.map((f) => {
        const isClosed = closed[f.path] === true;
        const FolderIcon = isClosed ? Folder : FolderOpen;
        return (
          <div key={f.path}>
            <button
              type="button"
              onClick={() => setClosed({ ...closed, [f.path]: !isClosed })}
              style={pad}
              className={cn(
                sidebarRowClass(),
                'w-[calc(100%-1rem)] cursor-pointer gap-1.5 pr-2 text-left',
              )}
              aria-expanded={!isClosed}
            >
              <FolderIcon className="h-3 w-3 shrink-0 text-[var(--wb-text-2)]" />
              <span className="truncate">{f.name}</span>
            </button>
            {!isClosed && <QueryNode node={f.node} depth={depth + 1} onOpen={onOpen} />}
          </div>
        );
      })}
      {node.queries.map((q) => (
        <div key={q.path} className={cn(sidebarRowClass(), 'group/q')} style={pad}>
          <button
            type="button"
            onClick={() => onOpen(q.path)}
            title={q.description || q.path}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 pr-1 text-left"
          >
            <File className="h-3 w-3 shrink-0 text-[var(--wb-text-2)]" />
            <span className="truncate">{q.name}</span>
          </button>
          {confirm === q.path ? (
            <button
              type="button"
              onClick={() => {
                setConfirm(null);
                void deleteQuery(q.path);
              }}
              className="mr-1 shrink-0 cursor-pointer text-[11px] text-[var(--status-prod)]"
            >
              Delete file?
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setConfirm(q.path)}
              aria-label={`Delete ${q.name}`}
              className="mr-1 grid h-5 w-5 shrink-0 cursor-pointer place-items-center text-[var(--wb-text-3)] opacity-0 hover:text-[var(--wb-text)] focus-visible:opacity-100 group-hover/q:opacity-100"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </div>
      ))}
    </>
  );
}

/** Load a workspace notebook into the notebook draft of the active connection and open it. */
async function openWorkspaceNotebook(file: string): Promise<void> {
  const session = useSession.getState();
  if (session.connectionState !== 'connected') {
    useWorkspace.setState({ notice: 'Connect to a database to open a notebook.' });
    return;
  }
  const existing = loadDraft(localStorage, session.activeConfig?.id);
  if (hasCellContent(existing)) {
    useWorkspace.setState({ notebookReplace: file });
    return;
  }
  await applyWorkspaceNotebook(file);
}

/** Replace the active connection's notebook draft with a workspace notebook and show it. */
export async function applyWorkspaceNotebook(file: string): Promise<void> {
  const nb = await ipc.workspace.readNotebook(file);
  useWorkspace.setState({ notebookReplace: null });
  if (!nb) return;
  const rev = useWorkspace.getState().snapshot?.notebooks.find((n) => n.file === file)?.rev ?? null;
  saveDraft(localStorage, useSession.getState().activeConfig?.id, nb.cells);
  useWorkspace.setState({ notebookLink: { file, rev, name: nb.name } });
  useWorkbench.getState().setOverlay('notebook');
}
