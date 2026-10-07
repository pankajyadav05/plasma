import type { PendingEdit } from '@/stores/session-types';
import {
  type RecoveredEdit,
  type RecoveryJournal,
  type RecoveryLaunchInfo,
  type SnapshotTarget,
  sameTarget,
} from '@shared/recovery';

/**
 * Crash recovery, renderer side, pure parts (B2). What gets written down
 * (`toRecoveredEdit`), how it comes back (`fromRecoveredEdit`, `restoreEdits`),
 * what to say about it, and the small amount of module state that carries the
 * snapshots main set aside from the first screen to the moment the right
 * connection is up. Nothing here runs SQL or touches the network: restoring
 * only re-stages edits and reopens tabs.
 */

// ─── What is written ─────────────────────────────────────────────────

function textOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' ? v : String(v);
}

function textMap(rec: Record<string, unknown> | undefined): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(rec ?? {})) out[k] = textOrNull(v);
  return out;
}

/** A staged edit as JSON-safe text, tied to its tab by position in the saved tab list. */
export function toRecoveredEdit(e: PendingEdit, tabIndex: number): RecoveredEdit {
  const kind = e.kind ?? 'update';
  return {
    tabIndex,
    kind,
    schema: e.schema,
    table: e.table,
    pkValues: textMap(e.pkValues),
    column: e.column,
    // A delete's raw row (`oldValue`) can hold values JSON cannot carry; its
    // text form lives in `originalRow`.
    oldValue: kind === 'delete' ? null : textOrNull(e.oldValue),
    ...(e.oldType ? { oldType: e.oldType } : {}),
    ...(e.oldNoEquality ? { oldNoEquality: true } : {}),
    ...(e.originalRow
      ? {
          originalRow: e.originalRow.map((c) => ({
            column: c.column,
            value: c.value,
            ...(c.type ? { type: c.type } : {}),
            ...(c.noEquality ? { noEquality: true } : {}),
          })),
        }
      : {}),
    newValue: e.newValue,
    ...(e.values ? { values: textMap(e.values) } : {}),
    ...(e.maybeCommitted ? { maybeCommitted: true } : {}),
  };
}

/** The reverse, re-stamped for the live tab and connection generation. */
export function fromRecoveredEdit(
  r: RecoveredEdit,
  tabId: string,
  connectionGen: number,
  id: string,
  rowKeyOf: (pk: Record<string, unknown>) => string,
): PendingEdit {
  return {
    id,
    tabId,
    schema: r.schema,
    table: r.table,
    kind: r.kind,
    pkValues: r.pkValues,
    ...(r.kind === 'insert' ? {} : { rowKey: rowKeyOf(r.pkValues) }),
    column: r.column,
    oldValue: r.oldValue,
    ...(r.oldType ? { oldType: r.oldType } : {}),
    ...(r.oldNoEquality ? { oldNoEquality: true } : {}),
    ...(r.originalRow ? { originalRow: r.originalRow } : {}),
    newValue: r.newValue,
    ...(r.values ? { values: r.values } : {}),
    ...(r.maybeCommitted ? { maybeCommitted: true } : {}),
    rowIndex: -1,
    columnIndex: -1,
    connectionGen,
  };
}

export interface RestoredEdits {
  /** Re-staged edits per live tab id, ready for `pendingEditsByTab`. */
  byTab: Record<string, PendingEdit[]>;
  restored: number;
  /** Edits whose tab did not come back (the saved tab was unusable): their table, to reopen. */
  orphans: RecoveredEdit[];
}

/**
 * Re-stage a journal's edits. `tabIdByIndex` maps a position in the saved tab
 * list to the live tab it became; an edit whose tab is not there is returned
 * as an orphan so the caller can reopen its table instead of losing it.
 */
export function restoreEdits(
  edits: readonly RecoveredEdit[],
  tabIdByIndex: ReadonlyMap<number, string>,
  connectionGen: number,
  newId: () => string,
  rowKeyOf: (pk: Record<string, unknown>) => string,
): RestoredEdits {
  const byTab: Record<string, PendingEdit[]> = {};
  const orphans: RecoveredEdit[] = [];
  let restored = 0;
  for (const r of edits) {
    const tabId = tabIdByIndex.get(r.tabIndex);
    if (!tabId) {
      orphans.push(r);
      continue;
    }
    const list = byTab[tabId] ?? [];
    list.push(fromRecoveredEdit(r, tabId, connectionGen, newId(), rowKeyOf));
    byTab[tabId] = list;
    restored++;
  }
  return { byTab, restored, orphans };
}

// ─── What to say ─────────────────────────────────────────────────────

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface RecoveryNotice {
  title: string;
  detail: string;
}

/** The toast after a restore: what came back, what did not, and that nothing was re-run. */
export function recoveryNotice(input: {
  cause: RecoveryLaunchInfo['cause'];
  tabs: number;
  edits: number;
  txnActive: boolean;
  /** Edits restored from a commit that was in flight when Plasma stopped. */
  maybeCommitted?: number;
  /** What the snapshot could not hold. */
  omitted?: { tabs: string[]; edits: number };
}): RecoveryNotice {
  const parts: string[] = [];
  const restored: string[] = [];
  if (input.tabs > 0) restored.push(plural(input.tabs, 'tab'));
  if (input.edits > 0) restored.push(plural(input.edits, 'unsaved edit'));
  parts.push(
    restored.length > 0 ? `Restored ${restored.join(' and ')}.` : 'There was nothing to restore.',
  );
  if (input.txnActive) {
    parts.push(
      'Your open transaction was rolled back, so its changes are gone. Run it again if you still need them.',
    );
  }
  if (input.maybeCommitted) {
    parts.push(
      `${plural(input.maybeCommitted, 'edit')} ${input.maybeCommitted === 1 ? 'was' : 'were'} being committed when Plasma stopped and may already be saved. Check the data before committing.`,
    );
  } else if (input.edits > 0) {
    parts.push('Staged edits are not committed until you commit them.');
  }
  if (input.omitted && input.omitted.edits > 0) {
    parts.push(
      `${plural(input.omitted.edits, 'edit')} could not be saved and ${input.omitted.edits === 1 ? 'is' : 'are'} lost.`,
    );
  }
  if (input.omitted && input.omitted.tabs.length > 0) {
    parts.push(
      `${plural(input.omitted.tabs.length, 'SQL tab')} (${input.omitted.tabs.slice(0, 3).join(', ')}) ${input.omitted.tabs.length === 1 ? 'was' : 'were'} too large to save.`,
    );
  }
  return {
    title:
      input.cause === 'renderer'
        ? 'The Plasma window crashed and was reloaded'
        : input.cause === null
          ? 'Restored unsaved work from an earlier session'
          : 'Plasma closed unexpectedly',
    detail: parts.join(' '),
  };
}

/** Shown when a snapshot exists but its connection is gone. Nothing is deleted. */
export function unrestorableNotice(
  journal: Pick<RecoveryJournal, 'connectionName' | 'edits' | 'strip'>,
): RecoveryNotice {
  const name = journal.connectionName ? ` “${journal.connectionName}”` : '';
  const what = [
    plural(journal.strip.tabs.length, 'tab'),
    ...(journal.edits.length > 0 ? [plural(journal.edits.length, 'unsaved edit')] : []),
  ].join(' and ');
  return {
    title: 'Plasma closed unexpectedly',
    detail: `${what} from connection${name} are kept, but that connection is not saved here, so they could not be restored. Add it again to get them back.`,
  };
}

// ─── Hand-over from the first screen to the connection ───────────────

let pending: RecoveryJournal[] = [];
let launchCause: RecoveryLaunchInfo['cause'] = null;
let hasLog = false;
const taken = new Set<string>();

/** The snapshots main set aside, kept until their connection is up and they are restored. */
export function setPendingRecoveries(info: RecoveryLaunchInfo): void {
  pending = info.journals;
  launchCause = info.cause;
  hasLog = info.hasLog;
  taken.clear();
}

/** The snapshot for this connection, once. */
export function takeRecoveryFor(
  connectionId: string | null,
  target?: SnapshotTarget | null,
): RecoveryJournal | null {
  if (!connectionId || taken.has(connectionId)) return null;
  const found = pending.find((j) => j.connectionId === connectionId);
  if (!found) return null;
  taken.add(connectionId);
  // The saved connection now points somewhere else (another host or database): the
  // staged edits were made against different data, so they are never applied here.
  if (found.target && target && !sameTarget(found.target, target)) {
    targetChangedHandler?.(found);
    return null;
  }
  return found;
}

let targetChangedHandler: ((journal: RecoveryJournal) => void) | null = null;

/** The app shell registers what to do with a snapshot taken against another target. */
export function onRecoveryTargetChanged(handler: ((j: RecoveryJournal) => void) | null): void {
  targetChangedHandler = handler;
}

export function recoveryContext(): { cause: RecoveryLaunchInfo['cause']; hasLog: boolean } {
  return { cause: launchCause, hasLog };
}

/** Test seam. */
export function resetPendingRecoveries(): void {
  pending = [];
  launchCause = null;
  hasLog = false;
  taken.clear();
}

/** Which connection to bring back first: the newest snapshot whose connection can be reached. */
export function pickJournalToResume(
  journals: readonly RecoveryJournal[],
  canResume: (connectionId: string) => boolean,
): RecoveryJournal | null {
  return (
    [...journals].sort((a, b) => b.savedAt - a.savedAt).find((j) => canResume(j.connectionId)) ??
    null
  );
}

// ─── Flush before a commit leaves ────────────────────────────────────

let beforeCommit: (() => Promise<unknown>) | null = null;

/** The app shell registers what must be on disk before a commit request is sent. */
export function setBeforeCommitHook(fn: (() => Promise<unknown>) | null): void {
  beforeCommit = fn;
}

/** Never blocks or fails a commit: the snapshot is a safety net, not a gate. */
export async function runBeforeCommitHook(): Promise<void> {
  try {
    await beforeCommit?.();
  } catch {
    // the commit goes ahead
  }
}

// ─── Restored notification ───────────────────────────────────────────

export interface RecoveryRestored {
  journal: RecoveryJournal;
  tabs: number;
  edits: number;
}

let restoredHandler: ((r: RecoveryRestored) => void) | null = null;

/** The app shell registers what to do once a snapshot is back in the stores (toast, resolve). */
export function onRecoveryRestored(handler: ((r: RecoveryRestored) => void) | null): void {
  restoredHandler = handler;
}

export function notifyRecoveryRestored(r: RecoveryRestored): void {
  restoredHandler?.(r);
}
