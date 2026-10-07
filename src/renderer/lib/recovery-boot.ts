import {
  type RecoveryNotice,
  type RecoveryRestored,
  pickJournalToResume,
  recoveryNotice,
} from '@/lib/crash-recovery';
import { type ResumePlan, planResume } from '@/lib/update-launch';
import type { UpdateToast } from '@/stores/update-toasts';
import { type RecoveryJournal, type RecoveryLaunchInfo, journalHasContent } from '@shared/recovery';

/**
 * What the first screen does with the recovery info main hands over (B2).
 * Reconnecting reuses the update-restart machinery (`planResume`): the same
 * saved connection or workspace profile comes back through the same reconnect
 * path, and nothing is run on it.
 *
 * Only a real crash reconnects by itself, and only to the newest snapshot whose
 * connection can be reached. Every other snapshot waiting on disk is offered once
 * (restore it by connecting, or discard it), one at a time, and never counts as a
 * crash.
 */

export interface RecoveryBootPlan {
  /** A crash: bring this connection back; its snapshot is restored once it is up. */
  resume: { journal: RecoveryJournal; plan: NonNullable<ResumePlan> } | null;
  /** A crash with nothing worth restoring: just say so. */
  noticeOnly: RecoveryLaunchInfo['cause'] | null;
  /** Snapshots to offer (once, one at a time): newest first, `restorable` = its connection exists. */
  offers: Array<{ journal: RecoveryJournal; restorable: boolean }>;
}

export function planRecoveryBoot(
  info: RecoveryLaunchInfo | null,
  savedConnections: readonly { id: string; name: string }[],
  workspaceProfileIds: readonly string[],
): RecoveryBootPlan {
  const none: RecoveryBootPlan = { resume: null, noticeOnly: null, offers: [] };
  if (!info) return none;
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
  const announced = new Set(info.announce);
  const candidates = info.journals.filter(
    (j) => announced.has(j.connectionId) && journalHasContent(j),
  );

  let resume: RecoveryBootPlan['resume'] = null;
  if (info.unclean) {
    const journal = pickJournalToResume(candidates, (id) => planFor(id) !== null);
    const plan = journal ? planFor(journal.connectionId) : null;
    if (journal && plan) resume = { journal, plan };
  }
  const offers = candidates
    .filter((j) => j !== resume?.journal)
    .sort((a, b) => b.savedAt - a.savedAt)
    .map((journal) => ({ journal, restorable: planFor(journal.connectionId) !== null }));
  return {
    resume,
    noticeOnly: info.unclean && !resume && offers.length === 0 ? info.cause : null,
    offers,
  };
}

export interface AnnounceDeps {
  push: (toast: Omit<UpdateToast, 'id'> & { id?: string }, autoDismissMs?: number) => string;
  dismiss: (id: string) => void;
  discardEdits: () => void;
  /** Forget one connection's waiting snapshot for good. */
  discardSnapshot: (connectionId: string) => void;
  /** Open a snapshot's SQL tabs as plain unsaved SQL (no connection, no edits). */
  openAsSql: (journal: RecoveryJournal) => void;
  showLog: () => void;
  hasLog: boolean;
}

const TOAST_ID = 'crash-recovery';

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
    maybeCommitted: restored.journal.edits.filter((e) => e.maybeCommitted).length,
    omitted: restored.journal.omitted,
  });
  deps.push({ id: TOAST_ID, ...toastFor(notice, deps, { edits: restored.edits }) });
}

export function announceNothingToRestore(
  cause: RecoveryLaunchInfo['cause'],
  deps: AnnounceDeps,
): void {
  const notice = recoveryNotice({ cause, tabs: 0, edits: 0, txnActive: false });
  deps.push({
    id: TOAST_ID,
    ...toastFor({ title: notice.title, detail: 'Nothing needed to be restored.' }, deps, {
      edits: 0,
    }),
  });
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function describeSnapshot(j: RecoveryJournal): string {
  const what = [
    plural(j.strip.tabs.length, 'tab'),
    ...(j.edits.length > 0 ? [plural(j.edits.length, 'unsaved edit')] : []),
  ].join(' and ');
  return `${what} from connection${j.connectionName ? ` “${j.connectionName}”` : ''}`;
}

/**
 * Offer waiting snapshots one at a time. Each says what it holds and what
 * happens next; "Discard" deletes it, "Keep for later" leaves it on disk (and it
 * is not announced again). Showing the next one is up to the user's choice.
 */
export function announceOffers(
  offers: ReadonlyArray<{ journal: RecoveryJournal; restorable: boolean }>,
  deps: AnnounceDeps,
  index = 0,
): void {
  const offer = offers[index];
  if (!offer) return;
  const id = `${TOAST_ID}-offer`;
  const next = () => {
    deps.dismiss(id);
    announceOffers(offers, deps, index + 1);
  };
  const remaining = offers.length - index - 1;
  deps.push({
    id,
    tone: 'warn',
    title: 'Unsaved work from an earlier session',
    detail: `${describeSnapshot(offer.journal)}. ${
      offer.restorable
        ? 'It comes back when you connect to it.'
        : 'That connection is not saved here, so it cannot be restored.'
    }${remaining > 0 ? ` (${remaining} more after this.)` : ''}`,
    actions: [
      {
        label: 'Discard',
        run: () => {
          deps.discardSnapshot(offer.journal.connectionId);
          next();
        },
      },
      { label: 'Keep for later', run: next },
    ],
  });
}

/** A snapshot whose connection now points somewhere else: never applied to the new target. */
export function announceTargetChanged(journal: RecoveryJournal, deps: AnnounceDeps): void {
  const id = `${TOAST_ID}-target`;
  deps.push({
    id,
    tone: 'warn',
    title: 'Saved work belongs to a different database',
    detail: `${describeSnapshot(journal)} was saved against another host or database than this connection now uses, so its edits were not restored.`,
    actions: [
      {
        label: 'Open its SQL',
        run: () => {
          deps.openAsSql(journal);
          deps.dismiss(id);
        },
      },
      {
        label: 'Discard',
        run: () => {
          deps.discardSnapshot(journal.connectionId);
          deps.dismiss(id);
        },
      },
      { label: 'Keep for later', run: () => deps.dismiss(id) },
    ],
  });
}
