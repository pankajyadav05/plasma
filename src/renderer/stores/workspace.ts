import { useStructureDialogs } from '@/features/structure/structure-dialogs-store';
import { ipc } from '@/lib/ipc';
import { listVariables, pruneVariableValues } from '@/lib/query-variables';
import {
  type ConnectionPrefill,
  type LaunchAction,
  parsePasted,
  sameEndpoint,
} from '@shared/deep-link';
import type { ConnectionConfig } from '@shared/protocol';
import type {
  RecentWorkspace,
  WorkspaceProfileView,
  WorkspaceSnapshot,
  WorkspaceWriteResult,
} from '@shared/workspace';
import { create } from 'zustand';
import { useSession } from './session';

/** Which editor tab came from which workspace file, and the revision it was loaded at. */
export interface TabLink {
  path: string;
  rev: string;
}

export interface SaveConflict {
  /** What was being saved, for the message. */
  what: string;
  /** Retry the same write, overwriting the file. */
  overwrite: () => Promise<void>;
}

interface ImportIntent {
  file: Extract<LaunchAction, { kind: 'import' }>['file'];
  into: ConnectionPrefill | null;
  schema: string | null;
  table: string;
}

interface WorkspaceState {
  snapshot: WorkspaceSnapshot | null;
  recents: RecentWorkspace[];
  links: Record<string, TabLink>;
  /** Profile whose password is being asked for. */
  passwordPrompt: WorkspaceProfileView | null;
  conflict: SaveConflict | null;
  /** Save-to-workspace dialog for the active tab. */
  saveDialog: { tabId: string } | null;
  connectionStringOpen: boolean;
  notice: string | null;
  pendingImport: ImportIntent | null;
  /** The notebook draft came from this workspace file (saves go back to it). */
  notebookLink: { file: string; rev: string | null; name: string } | null;
  /** Workspace notebook waiting for "replace your draft?" confirmation. */
  notebookReplace: string | null;

  load(): Promise<void>;
  setSnapshot(snapshot: WorkspaceSnapshot | null): void;
  openDialog(): Promise<void>;
  openRecent(path: string): Promise<void>;
  forgetRecent(path: string): Promise<void>;
  close(): Promise<void>;
  connectProfile(profileId: string): Promise<void>;
  submitPassword(password: string): Promise<void>;
  cancelPassword(): void;
  openQuery(path: string): void;
  saveTabAs(
    tabId: string,
    input: { name: string; folder: string; description?: string },
  ): Promise<void>;
  saveLinkedTab(tabId: string): Promise<boolean>;
  deleteQuery(path: string): Promise<void>;
  resolveConflict(overwrite: boolean): Promise<void>;
  dismissNotice(): void;
  handleLaunch(action: LaunchAction): Promise<void>;
  runPendingImport(): void;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  snapshot: null,
  recents: [],
  links: {},
  passwordPrompt: null,
  conflict: null,
  saveDialog: null,
  connectionStringOpen: false,
  notice: null,
  pendingImport: null,
  notebookLink: null,
  notebookReplace: null,

  async load() {
    try {
      const [snapshot, recents] = await Promise.all([
        ipc.workspace.current(),
        ipc.workspace.recents(),
      ]);
      set({ snapshot, recents });
    } catch (err) {
      console.error('[plasma] workspace load failed', err);
    }
  },

  setSnapshot(snapshot) {
    // A different (or closed) workspace invalidates the tab links.
    const sameWs = snapshot && get().snapshot?.id === snapshot.id;
    set({ snapshot, ...(sameWs ? {} : { links: {} }) });
    if (!snapshot) void ipc.workspace.recents().then((recents) => set({ recents }));
  },

  async openDialog() {
    try {
      const snapshot = await ipc.workspace.openDialog();
      if (snapshot) {
        get().setSnapshot(snapshot);
        set({ recents: await ipc.workspace.recents() });
      }
    } catch (err) {
      set({ notice: `Could not open the workspace: ${message(err)}` });
    }
  },

  async openRecent(path) {
    try {
      const snapshot = await ipc.workspace.openRecent(path);
      get().setSnapshot(snapshot);
      set({ recents: await ipc.workspace.recents() });
    } catch (err) {
      set({ notice: `Could not open the workspace: ${message(err)}` });
      set({ recents: await ipc.workspace.forgetRecent(path) });
    }
  },

  async forgetRecent(path) {
    set({ recents: await ipc.workspace.forgetRecent(path) });
  },

  async close() {
    await ipc.workspace.close();
    get().setSnapshot(null);
  },

  async connectProfile(profileId) {
    const snap = get().snapshot;
    const profile = snap?.profiles.find((p) => p.id === profileId);
    if (!profile) return;
    if (profile.error) {
      set({ notice: `${profile.name}: ${profile.error}` });
      return;
    }
    try {
      const { config, needsPassword } = await ipc.workspace.profileConfig(profileId);
      if (needsPassword) {
        set({ passwordPrompt: profile });
        return;
      }
      await connectWorkspaceConfig(config, profile);
    } catch (err) {
      set({ notice: `${profile.name}: ${message(err)}` });
    }
  },

  async submitPassword(password) {
    const profile = get().passwordPrompt;
    if (!profile) return;
    set({ passwordPrompt: null });
    try {
      await ipc.workspace.setPassword(profile.id, password);
      const { config } = await ipc.workspace.profileConfig(profile.id);
      await connectWorkspaceConfig(config, profile);
      // The stored state changed (needsPassword), refresh the list.
      set({ snapshot: await ipc.workspace.current() });
    } catch (err) {
      set({ notice: `${profile.name}: ${message(err)}` });
    }
  },

  cancelPassword() {
    set({ passwordPrompt: null });
  },

  openQuery(path) {
    const q = get().snapshot?.queries.find((x) => x.path === path);
    if (!q) return;
    const session = useSession.getState();
    const id = session.openSqlInNewTab(q.sql, { title: q.name, clean: true });
    if (Object.keys(q.variables).length > 0) {
      useSession.setState({
        tabs: useSession
          .getState()
          .tabs.map((t) => (t.id === id ? { ...t, queryVars: { ...q.variables } } : t)),
      });
    }
    set({ links: { ...get().links, [id]: { path: q.path, rev: q.rev } } });
  },

  async saveTabAs(tabId, input) {
    const tab = useSession.getState().tabs.find((t) => t.id === tabId);
    if (!tab || tab.kind !== 'sql') return;
    const variables = pruneVariableValues(tab.queryVars ?? {}, listVariables(tab.sql));
    const activeId = useSession.getState().activeConfig?.id;
    const connection = activeId ? profileIdOf(activeId) : undefined;
    const res = await ipc.workspace.writeQuery({
      name: input.name,
      folder: input.folder,
      description: input.description,
      ...(connection ? { connection } : {}),
      variables,
      sql: tab.sql,
      baseRev: null,
    });
    applyWrite(tabId, res);
  },

  async saveLinkedTab(tabId) {
    const link = get().links[tabId];
    const tab = useSession.getState().tabs.find((t) => t.id === tabId);
    const q = link ? get().snapshot?.queries.find((x) => x.path === link.path) : undefined;
    if (!link || !tab || tab.kind !== 'sql') return false;
    const variables = pruneVariableValues(tab.queryVars ?? {}, listVariables(tab.sql));
    const write = (overwrite: boolean) =>
      ipc.workspace.writeQuery({
        path: link.path,
        name: q?.name ?? tab.title,
        ...(q?.description ? { description: q.description } : {}),
        ...(q?.connection ? { connection: q.connection } : {}),
        variables,
        sql: tab.sql,
        baseRev: link.rev,
        overwrite,
      });
    const res = await write(false);
    if (!res.ok) {
      set({
        conflict: {
          what: q?.name ?? link.path,
          overwrite: async () => {
            applyWrite(tabId, await write(true));
          },
        },
      });
      return true;
    }
    applyWrite(tabId, res);
    return true;
  },

  async deleteQuery(path) {
    try {
      await ipc.workspace.deleteQuery(path);
      set({ snapshot: await ipc.workspace.current() });
    } catch (err) {
      set({ notice: `Could not delete: ${message(err)}` });
    }
  },

  async resolveConflict(overwrite) {
    const c = get().conflict;
    set({ conflict: null });
    if (overwrite && c) {
      try {
        await c.overwrite();
      } catch (err) {
        set({ notice: `Could not save: ${message(err)}` });
      }
    }
  },

  dismissNotice() {
    set({ notice: null });
  },

  async handleLaunch(action) {
    switch (action.kind) {
      case 'error':
        set({ notice: action.message });
        return;
      case 'workspace':
        set({ snapshot: await ipc.workspace.current(), recents: await ipc.workspace.recents() });
        return;
      case 'connect':
        openPrefilledDialog(action.prefill);
        return;
      case 'import':
        set({
          pendingImport: {
            file: action.file,
            into: action.into,
            schema: action.schema,
            table: action.table,
          },
        });
        await prepareImportConnection(action.into);
        get().runPendingImport();
        return;
    }
  },

  runPendingImport() {
    const intent = get().pendingImport;
    const s = useSession.getState();
    // The table list is part of the connect flow; wait until it has loaded.
    if (!intent || s.connectionState !== 'connected' || !s.activeConfig || !s.schema) return;
    if (intent.into && !sameEndpoint(intent.into, s.activeConfig)) return;
    const schema = intent.schema ?? s.currentSchema ?? 'public';
    const exists = s.schema?.tables.some((t) => t.schema === schema && t.name === intent.table);
    set({ pendingImport: null });
    useStructureDialogs.getState().openImport(schema, exists ? intent.table : null, {
      file: intent.file,
      newName: exists ? undefined : intent.table,
    });
  },
}));

/** Profile id inside a `ws:<workspace>:<profile>` connection id, if it is one. */
function profileIdOf(connectionId: string): string | undefined {
  const m = /^ws:[a-f0-9]{12}:(.+)$/.exec(connectionId);
  return m?.[1];
}

function applyWrite(tabId: string, res: WorkspaceWriteResult): void {
  if (!res.ok) {
    useWorkspace.setState({
      notice: 'The file changed on disk while saving. Nothing was written.',
    });
    return;
  }
  useWorkspace.setState((s) => ({
    links: { ...s.links, [tabId]: { path: res.path, rev: res.rev } },
  }));
  useSession.getState().markTabClean(tabId);
  void ipc.workspace.current().then((snapshot) => useWorkspace.setState({ snapshot }));
}

async function connectWorkspaceConfig(
  config: ConnectionConfig,
  profile: WorkspaceProfileView,
): Promise<void> {
  const s = useSession.getState();
  // The tag lives in settings keyed by connection id; the profile's tag wins when none is set.
  if (profile.tag && !s.settings.connectionTags?.[config.id]) {
    await s.setConnectionTag(config.id, profile.tag);
  }
  await useSession.getState().connect(config);
}

/** Fill the New Connection dialog (never connects). */
export function openPrefilledDialog(p: ConnectionPrefill): void {
  const config: ConnectionConfig = {
    id: crypto.randomUUID(),
    name: p.name,
    engine: p.engine,
    host: p.host,
    port: p.port,
    database: p.database,
    user: p.user,
    password: p.password,
    ssl: p.ssl,
    ...(p.tls ? { tls: p.tls } : {}),
    readOnly: p.readOnly,
  };
  useConnectionDraft.getState().setDraft(config.id);
  useSession.getState().openDialog(config);
}

/**
 * `isEditing` in the connection dialog means "prefill present". A link's
 * prefill is a brand-new connection, so the dialog asks this store whether
 * the prefill is such a draft.
 */
export const useConnectionDraft = create<{
  draftId: string | null;
  setDraft(id: string | null): void;
}>((set) => ({ draftId: null, setDraft: (draftId) => set({ draftId }) }));

/** Paste a connection string or link → the same parser as a deep link. */
export function openConnectionString(text: string): string | null {
  const action = parsePasted(text);
  if (action.kind === 'connect') {
    openPrefilledDialog(action.prefill);
    return null;
  }
  return action.kind === 'error' ? action.message : 'Unsupported link';
}

/**
 * For `plasma import … --into <url>`: use the matching saved or open
 * connection; otherwise open the dialog prefilled and finish the import
 * once the user connects.
 */
async function prepareImportConnection(into: ConnectionPrefill | null): Promise<void> {
  if (!into) return;
  const s = useSession.getState();
  if (s.connectionState === 'connected' && s.activeConfig && sameEndpoint(into, s.activeConfig))
    return;
  const saved = s.savedConnections.find((c) => sameEndpoint(into, c));
  if (saved && s.connectionState !== 'connecting') {
    await s.connectSaved(saved.id);
    return;
  }
  openPrefilledDialog(into);
}

// Finish a pending import as soon as the matching connection is up.
useSession.subscribe((state, prev) => {
  if (state.schema !== prev.schema || state.connectionState !== prev.connectionState) {
    if (useWorkspace.getState().pendingImport) useWorkspace.getState().runPendingImport();
  }
});
