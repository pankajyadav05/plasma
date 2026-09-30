/**
 * Connection-lifecycle helpers for the session store (B2 / C15 / C21 / G2).
 * Kept out of session.ts so they can be unit-tested without the store.
 */
import { ipc } from '@/lib/ipc';
import type {
  ConnectionConfig,
  ConnectionEngine,
  ConnectionRecovered,
  ConnectionSshConfig,
  SavedConnection,
} from '@shared/protocol';
import { redisConnectReset } from './session-redis';
import { clearTabResults } from './session-tab-model';
import { adoptConnectionTabs } from './session-tabs';
import type { ConnectionState, SessionState, SliceCreator } from './session-types';
import { useWorkbench } from './workbench';

/**
 * State that belongs to one server session and must not leak into the
 * next one (B2): schema tree, search_path pick, SET ROLE, role list,
 * per-engine overviews and bulk selections.
 */
export function freshSessionPatch() {
  return {
    schema: null,
    expandedSchemas: new Set<string>(),
    currentSchema: null,
    activeTable: null,
    activeRole: null,
    availableRoles: [] as string[],
    roleError: null,
    txnState: 'none' as const,
    redisOverview: null,
    redisKeys: null,
    redisMatch: null,
    osOverview: null,
    activeRedisKey: null,
    activeOsIndex: null,
    redisBulkMode: false,
    selectedRedisKeys: new Set<string>(),
  };
}

/** `SET ROLE "<name>"` with the identifier quoted. */
export function setRoleSql(role: string): string {
  return `SET ROLE "${role.replace(/"/g, '""')}"`;
}

/** Error text without Electron's "Error invoking remote method …" wrapper. */
export function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+':\s*/i, '').replace(/^Error:\s*/i, '');
}

// ─── Slice ───────────────────────────────────────────────────────────

export type ConnectionActionGate =
  | { kind: 'connect'; config: ConnectionConfig }
  | { kind: 'connectSaved'; id: string }
  | { kind: 'disconnect' };

type SessionSet = (
  partial: Partial<SessionState> | ((s: SessionState) => Partial<SessionState>),
) => void;

export interface ConnectionSlice {
  // ── connection ──
  activeConfig: ConnectionConfig | null;
  connectionState: ConnectionState;
  connectionError: string | null;
  serverVersion: string | null;
  /** Bumped on every (re)connect; stale results and approvals are checked against it. */
  connectionGen: number;
  /** A connect / disconnect waiting on the pending-edits tray (commit or discard first). */
  connectionActionGate: ConnectionActionGate | null;
  resolveConnectionAction(choice: 'commit' | 'discard'): Promise<void>;
  cancelConnectionAction(): void;
  // ── saved connections ──
  savedConnections: SavedConnection[];
  /** Save a connection without connecting (C28). */
  saveConnectionOnly(config: ConnectionConfig): Promise<void>;
  /** Copy a saved connection under a new id and refresh the list (C28). */
  duplicateSaved(id: string): Promise<SavedConnection>;

  /** `ssh`: the dialog's tunnel settings (null = no tunnel, omitted = the saved ones). */
  testConnection(
    config: ConnectionConfig,
    ssh?: ConnectionSshConfig | null,
  ): Promise<{ ok: boolean; message: string }>;
  connect(config: ConnectionConfig): Promise<void>;
  disconnect(): Promise<void>;
  /** Clear local connection state after an unexpected worker restart (U20). */
  handleWorkerReset(): void;
  /**
   * Adopt the session main re-established after a network/VPN drop (U27).
   * The generation changes, so in-flight results and pending edits from
   * the previous generation stop being committable by design.
   */
  handleConnectionRecovered(recovered: ConnectionRecovered): void;
  // Vault
  loadSavedConnections(): Promise<void>;
  connectSaved(id: string): Promise<void>;
  deleteSaved(id: string): Promise<void>;
  /** Load a saved connection's full config (with password) and open the dialog in edit mode. */
  editConnection(id: string): Promise<void>;
}

export const createConnectionSlice: SliceCreator<ConnectionSlice> = (set, get) => ({
  activeConfig: null,
  connectionState: 'idle',
  connectionError: null,
  serverVersion: null,
  connectionGen: 0,
  connectionActionGate: null,
  savedConnections: [],

  // ── connection ──

  async testConnection(config, ssh) {
    try {
      const res = await ipc.conn.test(config, ssh);
      if (res.ok) {
        return { ok: true, message: `Connected · ${shortVersion(res.serverVersion)}` };
      }
      return { ok: false, message: res.message };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  },

  async connect(config) {
    if (get().pendingEdits.length > 0) {
      set({ connectionActionGate: { kind: 'connect', config } });
      return;
    }
    // C12: one connect at a time — a second click or the reconnect timer
    // must not race the attempt already in flight.
    if (get().connectionState === 'connecting') return;
    set({ connectionState: 'connecting', connectionError: null });
    try {
      const { serverVersion, engine, connectionGen } = await ipc.conn.connect(config);
      const eff = (engine ?? config.engine ?? 'postgres') as ConnectionEngine;
      beginSession(set, get, { ...config, engine: eff }, serverVersion, connectionGen);
      await get().loadSavedConnections();
      if (config.id && get().savedConnections.some((c) => c.id === config.id)) {
        rememberLastConnection(get, config.id);
      }
      await loadEngineOverview(set, get, eff);
      adoptConnectionTabs(set, get, eff);
      if (eff === 'postgres') void get().loadAvailableRoles();
    } catch (err) {
      failConnect(set, err);
    }
  },

  async connectSaved(id) {
    if (get().pendingEdits.length > 0) {
      set({ connectionActionGate: { kind: 'connectSaved', id } });
      return;
    }
    if (get().connectionState === 'connecting') return; // C12
    set({ connectionState: 'connecting', connectionError: null });
    try {
      const { info, config } = await ipc.vault.connectById(id);
      const eff = (info.engine ?? config.engine ?? 'postgres') as ConnectionEngine;
      beginSession(set, get, { ...config, engine: eff }, info.serverVersion, info.connectionGen);
      rememberLastConnection(get, id);
      await loadEngineOverview(set, get, eff);
      adoptConnectionTabs(set, get, eff);
      if (eff === 'postgres') void get().loadAvailableRoles();
    } catch (err) {
      failConnect(set, err);
    }
  },

  async disconnect() {
    if (get().pendingEdits.length > 0) {
      set({ connectionActionGate: { kind: 'disconnect' } });
      return;
    }
    // A deliberate disconnect must not be undone by auto-connect on relaunch.
    if (get().settings.lastConnectionId) void get().updateSettings({ lastConnectionId: null });
    try {
      await ipc.conn.disconnect();
    } finally {
      set({
        ...freshSessionPatch(),
        activeConfig: null,
        serverVersion: null,
        connectionState: 'idle',
        connectionGen: 0,
      });
      // Clear all tabs' results since they reference a now-dead connection
      clearTabResults(set);
    }
  },

  handleWorkerReset() {
    set({
      ...freshSessionPatch(),
      activeConfig: null,
      serverVersion: null,
      connectionState: 'idle',
      connectionError: null,
    });
    // Clear all tabs' results since they reference a now-dead connection
    clearTabResults(set, { queryRunState: 'idle', queryRunningRange: null, queryErrorRange: null });
  },

  handleConnectionRecovered(recovered) {
    // C11: a recovery for a connection the user already left is stale.
    const active = get().activeConfig;
    if (recovered.connectionId && active && active.id !== recovered.connectionId) return;
    if (!active && recovered.connectionId) return;
    // Main reconnected for us, so the app is genuinely connected again —
    // but on a brand-new server session: no open transaction, and a new
    // generation that in-flight results and staged edits are checked
    // against (U01/U27). Pending edits are deliberately kept so the user
    // decides whether to discard them; the write gate refuses them.
    const lostRole = get().activeRole;
    set({
      connectionState: 'connected',
      connectionError: null,
      serverVersion: recovered.serverVersion,
      connectionGen: recovered.connectionGen,
      txnState: 'none',
    });
    // C15: SET ROLE lived on the old server session. Re-apply it so the UI
    // never shows a role the queries aren't running as; if that fails,
    // clear it and say so.
    if (lostRole) {
      void ipc.query
        .run(setRoleSql(lostRole), undefined, { internal: true })
        .then(() => set({ roleError: null }))
        .catch((err: unknown) => {
          set({
            activeRole: null,
            roleError: `Reconnected as the login role — SET ROLE ${lostRole} could not be restored: ${errorText(err)}`,
          });
        });
    }
  },

  // ── vault ──

  async loadSavedConnections() {
    try {
      const saved = await ipc.vault.list();
      set({ savedConnections: saved });
    } catch (err) {
      console.error('[plasma] vault.list failed', err);
    }
  },

  async saveConnectionOnly(config) {
    await ipc.vault.save(config);
    await get().loadSavedConnections();
  },

  async duplicateSaved(id) {
    const copy = await ipc.vault.duplicate(id);
    await get().loadSavedConnections();
    // Settings-side copies (tag, SSH, safe mode) were made in main.
    await get().loadSettings();
    return copy;
  },

  async deleteSaved(id) {
    try {
      await ipc.vault.delete(id);
    } finally {
      set({ deleteConfirmConnectionId: null });
      await get().loadSavedConnections();
    }
  },

  async editConnection(id) {
    try {
      const config = await ipc.vault.getConfig(id);
      if (!config) {
        console.error('[plasma] editConnection: no saved connection with id', id);
        return;
      }
      get().openDialog(config);
    } catch (err) {
      console.error('[plasma] editConnection failed', err);
    }
  },

  async resolveConnectionAction(choice: 'commit' | 'discard'): Promise<void> {
    const gate = get().connectionActionGate;
    if (!gate) return;
    if (choice === 'commit') await get().commitPendingEdits();
    else set({ pendingEdits: [], pendingEditsError: null });
    set({ connectionActionGate: null });
    // Prod-tagged: the commit waits on its own confirmation — stop here and
    // let the user retry the connection action once the tray is empty.
    if (get().pendingEdits.length > 0) return;
    if (gate.kind === 'disconnect') await get().disconnect();
    else if (gate.kind === 'connect') await get().connect(gate.config);
    else await get().connectSaved(gate.id);
  },
  cancelConnectionAction() {
    set({ connectionActionGate: null });
  },
});

function shortVersion(full: string): string {
  const m = full.match(/^(PostgreSQL\s+[\d.]+)/);
  return m ? m[1] : full;
}

/**
 * Bring the right kind of overview / introspection online based on
 * which engine the worker just connected to. Postgres uses the existing
 * `refreshSchema` (full table/column/FK introspection); Redis fetches
 * INFO + an initial SCAN page; OpenSearch fetches cluster + index list.
 */
async function loadEngineOverview(
  set: (patch: Partial<SessionState>) => void,
  get: () => SessionState,
  engine: ConnectionEngine,
): Promise<void> {
  if (engine === 'postgres') {
    await get().refreshSchema();
    const schema = get().schema;
    if (schema && schema.schemas.length > 0) {
      const first = schema.schemas.find((s) => s.name === 'public') ?? schema.schemas[0];
      set({ expandedSchemas: new Set([first.name]), currentSchema: first.name });
    }
    return;
  }
  if (engine === 'redis') {
    await get().refreshRedisOverview();
    await get().scanRedisKeys({ cursor: '0' });
    return;
  }
  if (engine === 'opensearch') {
    await get().refreshOsOverview();
  }
}

/**
 * Start a fresh server session (B2): nothing from the previous one survives,
 * edit mode never carries over (R2) and Redis starts on the configured db (R20).
 */
function beginSession(
  set: SessionSet,
  get: () => SessionState,
  config: Omit<ConnectionConfig, 'password'>,
  serverVersion: string,
  connectionGen: number | undefined,
): void {
  set(freshSessionPatch());
  // Tab identity/SQL stay (adoptConnectionTabs decides which tabs survive);
  // results, selections and the inspected row belong to the old session.
  useWorkbench.getState().setInspectedRow(null);
  clearTabResults(set, { totalRowCount: null, rlsPolicyCount: null });
  set({
    ...redisConnectReset(config),
    // Never keep the password in renderer state (C17); main holds it.
    activeConfig: { ...config, password: '' },
    serverVersion,
    connectionGen: connectionGen ?? get().connectionGen + 1,
    connectionState: 'connected',
    dialogOpen: false,
    dialogPrefill: null,
  });
}

/**
 * C21: main dropped the old session before dialling (the worker tore it
 * down), so the UI must stop showing it as live.
 */
function failConnect(set: SessionSet, err: unknown): void {
  set({
    ...freshSessionPatch(),
    activeConfig: null,
    serverVersion: null,
    connectionGen: 0,
    connectionState: 'error',
    connectionError: err instanceof Error ? err.message : String(err),
  });
  useWorkbench.getState().setInspectedRow(null);
  clearTabResults(set, { totalRowCount: null, rlsPolicyCount: null });
}

function rememberLastConnection(get: () => SessionState, id: string) {
  if (get().settings.lastConnectionId !== id) void get().updateSettings({ lastConnectionId: id });
}
