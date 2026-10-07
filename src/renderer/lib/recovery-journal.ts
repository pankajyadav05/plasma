import { toRecoveredEdit } from '@/lib/crash-recovery';
import type { PendingEditsByTab } from '@/stores/session-pending-edits';
import { serializeTabsIndexed } from '@/stores/session-tabs';
import type { QueryTab } from '@/stores/session-types';
import type { RecoveredEdit, RecoveryJournal } from '@shared/recovery';
import { engineCaps } from '@shared/sql-dialect';

/**
 * The writer half of crash recovery (B2): builds a snapshot of the live
 * workspace and keeps main's copy current. Snapshots go out a moment after any
 * change (debounced) and immediately when the window loses focus, is hidden or
 * unloads, so what a kill can cost is a fraction of a second of typing.
 *
 * A snapshot never holds results or Safe Run previews, and restoring one never
 * runs anything.
 */

export interface JournalSource {
  tabs: QueryTab[];
  activeTabId: string;
  tabsConnectionId?: string | null;
  pendingEditsByTab: PendingEditsByTab;
  txnState?: string;
  activeConfig: { id?: string; name?: string; engine?: string } | null;
  savedConnections: ReadonlyArray<{ id: string; name: string; engine?: string }>;
}

/**
 * The snapshot for the current workspace, or null when there is nothing to
 * attach it to (no SQL connection whose tabs are loaded). `fallbackConnectionId`
 * is the connection last seen live: after the worker restarts, `activeConfig`
 * is gone but the tabs and staged edits are still in memory and still belong to it.
 */
export function buildJournal(
  state: JournalSource,
  now: number,
  fallbackConnectionId: string | null = null,
): RecoveryJournal | null {
  const connId = state.activeConfig?.id ?? fallbackConnectionId;
  if (!connId || state.tabsConnectionId !== connId) return null;
  const saved = state.savedConnections.find((c) => c.id === connId);
  const engine = state.activeConfig?.engine ?? saved?.engine ?? 'postgres';
  if (!engineCaps(engine).sql) return null;

  const { data, indexById } = serializeTabsIndexed(state.tabs, state.activeTabId);
  const edits: RecoveredEdit[] = [];
  for (const [tabId, list] of Object.entries(state.pendingEditsByTab)) {
    const index = indexById.get(tabId);
    // A tab that is not saved (oversized buffer) cannot hold edits across a restart;
    // its table is reopened from the edit itself, so the edit is still written.
    for (const e of list) edits.push(toRecoveredEdit(e, index ?? Number.MAX_SAFE_INTEGER));
  }
  return {
    v: 1,
    savedAt: now,
    connectionId: connId,
    ...(state.activeConfig?.name || saved?.name
      ? { connectionName: state.activeConfig?.name ?? saved?.name }
      : {}),
    txnActive: state.txnState === 'active' || state.txnState === 'error',
    strip: data as unknown as RecoveryJournal['strip'],
    edits,
  };
}

interface Store<S> {
  getState(): S;
  subscribe(listener: (state: S, prev: S) => void): () => void;
}

interface RecoveryApi {
  save(j: RecoveryJournal | null): void;
  flush(j: RecoveryJournal | null): Promise<boolean>;
}

const DEBOUNCE_MS = 250;

let flushNow: (() => Promise<boolean>) | null = null;
let suspend: (() => void) | null = null;

/** Write the current snapshot now and say whether it reached the disk. */
export function flushRecoveryJournal(): Promise<boolean> {
  return flushNow ? flushNow() : Promise.resolve(false);
}

/**
 * A deliberate disconnect: forget the snapshot, and stay quiet until a
 * connection is live again (the tabs still in memory are no longer "in use").
 */
export function suspendRecoveryJournal(): void {
  suspend?.();
}

export function installRecoveryJournal<S extends JournalSource & { connectionState?: string }>(
  store: Store<S>,
  api: RecoveryApi,
  win: Pick<Window, 'addEventListener' | 'removeEventListener'> & {
    document?: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
  } = window,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastText: string | null = null;
  let lastConnectionId: string | null = null;
  let suspended = false;
  const first = store.getState();
  if (first.connectionState === 'connected' && first.activeConfig?.id) {
    lastConnectionId = first.activeConfig.id;
  }

  const current = (): RecoveryJournal | null => {
    if (suspended) return null;
    return buildJournal(store.getState(), Date.now(), lastConnectionId);
  };
  const fingerprint = (j: RecoveryJournal) => JSON.stringify({ ...j, savedAt: 0 });

  const write = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const j = current();
    if (!j) return;
    const text = fingerprint(j);
    if (text === lastText) return;
    lastText = text;
    api.save(j);
  };

  const unsub = store.subscribe((state, prev) => {
    if (state.connectionState === 'connected' && state.activeConfig?.id) {
      lastConnectionId = state.activeConfig.id;
      suspended = false;
    }
    if (
      state.tabs === prev.tabs &&
      state.activeTabId === prev.activeTabId &&
      state.pendingEditsByTab === prev.pendingEditsByTab &&
      state.txnState === prev.txnState &&
      state.tabsConnectionId === prev.tabsConnectionId
    ) {
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(write, DEBOUNCE_MS);
  });

  const onHide = () => {
    if (win.document && win.document.visibilityState !== 'hidden') return;
    write();
  };
  win.addEventListener('blur', write);
  win.addEventListener('pagehide', write);
  win.addEventListener('beforeunload', write);
  win.document?.addEventListener('visibilitychange', onHide);

  flushNow = async () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const j = current();
    if (!j) return false;
    lastText = fingerprint(j);
    return api.flush(j);
  };
  suspend = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    suspended = true;
    lastText = null;
    api.save(null);
  };

  return () => {
    unsub();
    if (timer) clearTimeout(timer);
    win.removeEventListener('blur', write);
    win.removeEventListener('pagehide', write);
    win.removeEventListener('beforeunload', write);
    win.document?.removeEventListener('visibilitychange', onHide);
    flushNow = null;
    suspend = null;
  };
}
