import {
  type RecoveryNotice,
  type RecoveryRestored,
  pickJournalToResume,
  recoveryNotice,
  unrestorableNotice,
} from '@/lib/crash-recovery';
import { type ResumePlan, planResume } from '@/lib/update-launch';
import type { UpdateToast } from '@/stores/update-toasts';
import { type RecoveryJournal, type RecoveryLaunchInfo, journalHasContent } from '@shared/recovery';

/**
 * What the first screen does with the recovery info main hands over (B2).
 * Reconnecting reuses the update-restart machinery (`planResume`): the same
 * saved connection or workspace profile comes back through the same reconnect
 * path, and nothing is run on it.
 */

export type RecoveryBootPlan =
  /** The last run ended cleanly and nothing is waiting. */
  | { kind: 'none' }
  /** Plasma closed badly but there is nothing to put back. */
  | { kind: 'notice-only'; cause: RecoveryLaunchInfo['cause'] }
  /** Bring this connection back; its snapshot is restored once it is up. */
  | { kind: 'resume'; journal: RecoveryJournal; plan: NonNullable<ResumePlan> }
  /** A snapshot exists, but its connection is no longer available. It is kept. */
  | { kind: 'unrestorable'; journal: RecoveryJournal };

export function planRecoveryBoot(
  info: RecoveryLaunchInfo | null,
  savedConnections: readonly { id: string; name: string }[],
  workspaceProfileIds: readonly string[],
): RecoveryBootPlan {
  if (!info || !info.unclean) return { kind: 'none' };
  const withContent = info.journals.filter(journalHasContent);
  const planFor = (connectionId: string): ResumePlan =>
    planResume(
      {
        resume: true,
        connectionId,
        outcome: 'none',
        version: null,
        logPath: null,
        downloadUrl: null,
      },
      savedConnections,
      workspaceProfileIds,
    );
  const journal = pickJournalToResume(withContent, (id) => planFor(id) !== null);
  if (journal) {
    const plan = planFor(journal.connectionId);
    if (plan) return { kind: 'resume', journal, plan };
  }
  const first = withContent[0];
  if (first) return { kind: 'unrestorable', journal: first };
  return { kind: 'notice-only', cause: info.cause };
}

export interface AnnounceDeps {
  push: (toast: Omit<UpdateToast, 'id'> & { id?: string }, autoDismissMs?: number) => string;
  discardEdits: () => void;
  showLog: () => void;
  hasLog: boolean;
}

function toastFor(
  notice: RecoveryNotice,
  deps: AnnounceDeps,
  opts: { edits: number },
): Omit<UpdateToast, 'id'> {
  return {
    tone: 'warn',
    title: notice.title,
    detail: notice.detail,
    actions: [
      ...(opts.edits > 0 ? [{ label: 'Discard edits', run: deps.discardEdits }] : []),
      ...(deps.hasLog ? [{ label: 'Show crash log', run: deps.showLog }] : []),
    ],
  };
}

/** "Plasma closed unexpectedly. Restored 4 tabs and 3 unsaved edits." */
export function announceRestored(
  restored: RecoveryRestored,
  cause: RecoveryLaunchInfo['cause'],
  deps: AnnounceDeps,
): void {
  const notice = recoveryNotice({
    cause,
    tabs: restored.tabs,
    edits: restored.edits,
    txnActive: restored.journal.txnActive,
  });
  deps.push({ id: 'crash-recovery', ...toastFor(notice, deps, { edits: restored.edits }) });
}

export function announceNothingToRestore(
  cause: RecoveryLaunchInfo['cause'],
  deps: AnnounceDeps,
): void {
  const notice = recoveryNotice({ cause, tabs: 0, edits: 0, txnActive: false });
  deps.push({
    id: 'crash-recovery',
    ...toastFor({ title: notice.title, detail: 'Nothing needed to be restored.' }, deps, {
      edits: 0,
    }),
  });
}

export function announceUnrestorable(journal: RecoveryJournal, deps: AnnounceDeps): void {
  deps.push({
    id: 'crash-recovery',
    ...toastFor(unrestorableNotice(journal), deps, { edits: 0 }),
  });
}
