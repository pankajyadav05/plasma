import { ErrorBoundary } from '@/components/ErrorBoundary';
import { TooltipLayer } from '@/components/ui/tooltip-layer';
import { AppShell } from '@/features/app-shell/AppShell';
import { HostKeyDialog } from '@/features/connection-manager/HostKeyDialog';
import { DataFilesDialogs } from '@/features/data-files/DataFilesDialogs';
import { type CommandId, runCommand } from '@/features/keymap/commands';
import { WorkspaceDialogs } from '@/features/workspace/WorkspaceDialogs';
import { routeAiTaskEvent } from '@/lib/ai-task';
import {
  onRecoveryRestored,
  onRecoveryTargetChanged,
  recoveryContext,
  setBeforeCommitHook,
  setPendingRecoveries,
} from '@/lib/crash-recovery';
import {
  type AnnounceDeps,
  announceNothingToRestore,
  announceOffers,
  announceRestored,
  announceTargetChanged,
  planRecoveryBoot,
} from '@/lib/recovery-boot';
import { flushRecoveryJournal, installRecoveryJournal } from '@/lib/recovery-journal';
import { announceUpdateOutcome, planResume } from '@/lib/update-launch';
import { handleDroppedDataFiles } from '@/stores/data-files';
import { useReconnect } from '@/stores/reconnect';
import { useSession } from '@/stores/session';
import { discardAllPendingEdits } from '@/stores/session-pending-edits';
import { createEmptyTab } from '@/stores/session-tab-model';
import { flushPersistedTabs, restoreTabsOnceFor } from '@/stores/session-tabs';
import { useUpdateToasts } from '@/stores/update-toasts';
import { useWorkspace } from '@/stores/workspace';
import type { LaunchAction } from '@shared/deep-link';
import { ConnectionRecovered, type DataFilePickResult } from '@shared/protocol';
import type { RecoveryLaunchInfo } from '@shared/recovery';
import type { WorkspaceSnapshot } from '@shared/workspace';
import { useEffect } from 'react';

type EventChannel = Parameters<Window['plasmaEvents']['on']>[0];

const MENU_COMMANDS: ReadonlyArray<readonly [EventChannel, CommandId]> = [
  ['plasma:menu:newTab', 'newTab'],
  ['plasma:menu:closeTab', 'closeTab'],
  ['plasma:menu:toggleSidebar', 'toggleSidebar'],
  ['plasma:menu:toggleEditor', 'toggleEditor'],
  ['plasma:menu:palette', 'palette'],
  ['plasma:menu:toggleAi', 'toggleAi'],
  ['plasma:menu:cheatSheet', 'cheatSheet'],
  ['plasma:menu:runQuery', 'runQuery'],
  ['plasma:menu:runQueryAll', 'runQueryAll'],
  ['plasma:menu:cancelQuery', 'cancelQuery'],
  ['plasma:menu:history', 'history'],
  ['plasma:menu:exportCsv', 'exportCsv'],
  ['plasma:menu:exportJson', 'exportJson'],
  ['plasma:menu:settings', 'settings'],
  ['plasma:menu:refresh', 'refresh'],
  ['plasma:menu:commitEdits', 'commitEdits'],
  ['plasma:menu:saveFileAs', 'saveFileAs'],
  ['plasma:menu:openFile', 'openFile'],
  ['plasma:menu:backup', 'backup'],
  ['plasma:menu:restore', 'restore'],
  ['plasma:menu:roles', 'roles'],
  ['plasma:menu:dbSearch', 'dbSearch'],
  ['plasma:menu:erDiagram', 'erDiagram'],
  ['plasma:menu:splitPane', 'splitPane'],
  ['plasma:menu:openWorkspace', 'openWorkspace'],
  ['plasma:menu:openDataFile', 'openDataFile'],
  ['plasma:menu:supportBundle', 'supportBundle'],
];

let recoveryWired = false;

/** B2: keep main's crash snapshot current, and say what was restored once a snapshot is back. */
function wireCrashRecovery(): AnnounceDeps {
  const toasts = () => useUpdateToasts.getState();
  const deps: AnnounceDeps = {
    push: (toast, ms) => toasts().push(toast, ms),
    dismiss: (id) => toasts().dismiss(id),
    discardEdits: () => {
      discardAllPendingEdits(useSession.setState);
      toasts().dismiss('crash-recovery');
    },
    discardSnapshot: (connectionId) => void window.plasma.recovery.resolve(connectionId),
    openAsSql: (journal) => {
      // Plain unsaved SQL tabs: no connection is attached and no edit comes with them.
      const s = useSession.getState();
      const pageSize = s.settings.defaultPageSize;
      const added = journal.strip.tabs
        .filter((t) => t.kind === 'sql' && typeof t.sql === 'string' && t.sql.trim() !== '')
        .map((t) => ({
          ...createEmptyTab(pageSize, `recovered-${String(t.title ?? 'query')}`),
          sql: String(t.sql),
        }));
      if (added.length > 0) useSession.setState({ tabs: [...s.tabs, ...added] });
      void window.plasma.recovery.resolve(journal.connectionId);
    },
    showLog: () => void window.plasma.recovery.showLog(),
    hasLog: recoveryContext().hasLog,
  };
  if (recoveryWired) return deps;
  recoveryWired = true;
  installRecoveryJournal(useSession, window.plasma.recovery);
  setBeforeCommitHook(flushRecoveryJournal);
  onRecoveryTargetChanged((journal) => announceTargetChanged(journal, deps));
  onRecoveryRestored((restored) => {
    announceRestored(restored, recoveryContext().cause, {
      ...deps,
      hasLog: recoveryContext().hasLog,
    });
    // The restored state must be in the live snapshot before the old one is let go, so a
    // crash right now still has something to restore. If it could not be written, the old
    // one is set aside (never restored a second time) instead of deleted.
    void flushRecoveryJournal()
      .then((ok) => window.plasma.recovery.resolve(restored.journal.connectionId, !ok))
      .catch(() => undefined);
  });
  return deps;
}

export function App() {
  useEffect(() => {
    void (async () => {
      const session = useSession.getState();
      await session.loadSettings();
      await session.loadSavedConnections();
      // D1/D2: the open workspace, and links / launcher requests that arrived
      // while the window was still loading (e.g. the app was started by one).
      await useWorkspace.getState().load();
      for (const action of await window.plasma.deepLink.takePending()) {
        await useWorkspace.getState().handleLaunch(action);
      }

      const { savedConnections, connectionState, settings } = useSession.getState();
      // Did an update just restart Plasma? Say how it went, and bring the session back
      // even when "Connect on launch" / "Restore tabs on launch" are off: that restart
      // was not the user's choice to close.
      const update = await window.plasma.update.launchInfo().catch(() => null);
      announceUpdateOutcome(update);
      const resume = planResume(
        update,
        savedConnections,
        useWorkspace.getState().snapshot?.profiles.map((p) => p.id) ?? [],
      );
      // B2: did Plasma crash or get killed last time? Snapshots main set aside wait here
      // until their connection is up (adoptConnectionTabs restores them).
      const crash = await window.plasma.recovery.launchInfo().catch(() => null);
      if (crash) setPendingRecoveries(crash);
      const recoveryDeps = wireCrashRecovery();
      const recoveryPlan = planRecoveryBoot(
        resume ? { ...(crash as RecoveryLaunchInfo), unclean: false } : crash,
        savedConnections,
        useWorkspace.getState().snapshot?.profiles.map((p) => p.id) ?? [],
      );
      if (recoveryPlan.noticeOnly !== null) {
        announceNothingToRestore(recoveryPlan.noticeOnly, recoveryDeps);
        void window.plasma.recovery.resolve();
      }
      announceOffers(recoveryPlan.offers, recoveryDeps);
      if (recoveryPlan.resume && connectionState === 'idle') {
        const target = recoveryPlan.resume.plan;
        if (target.kind === 'saved') {
          useReconnect.getState().start({ id: target.id, name: target.name }, 'launch');
        } else {
          await useWorkspace.getState().connectProfile(target.profileId);
        }
        return;
      }
      if (resume && connectionState === 'idle') {
        restoreTabsOnceFor(resume.kind === 'saved' ? resume.id : resume.connectionId);
        if (resume.kind === 'saved') {
          useReconnect.getState().start({ id: resume.id, name: resume.name }, 'launch');
        } else {
          await useWorkspace.getState().connectProfile(resume.profileId);
        }
        return;
      }
      if (savedConnections.length === 0 && connectionState === 'idle') {
        session.openDialog();
        return;
      }
      // Auto-connect to the connection used last time (skipped after an
      // explicit disconnect, which clears lastConnectionId).
      const last = savedConnections.find((c) => c.id === settings.lastConnectionId);
      if (settings.autoConnectOnLaunch && last && connectionState === 'idle') {
        useReconnect.getState().start({ id: last.id, name: last.name }, 'launch');
      }
    })();
  }, []);

  // Wire up native menu → renderer action events from the main process.
  useEffect(() => {
    const session = useSession.getState;
    const unsub = [
      // Native menu items dispatch through the same command table as the
      // keyboard and the palette (features/keymap/commands.ts).
      ...MENU_COMMANDS.map(([channel, id]) =>
        window.plasmaEvents.on(channel, () => runCommand(id)),
      ),
      // Main is about to restart for an update: write the tab strip down now and say
      // which connection is live, so the next launch can bring both back.
      window.plasmaEvents.on('plasma:update:prepare', () => {
        (document.activeElement as HTMLElement | null)?.blur?.(); // commit a field mid-edit
        flushPersistedTabs();
        const s = session();
        void window.plasma.update.prepared({
          connectionId: s.connectionState === 'connected' ? (s.activeConfig?.id ?? null) : null,
        });
      }),
      window.plasmaEvents.on('plasma:workspace:changed', (...args: unknown[]) => {
        useWorkspace.getState().setSnapshot((args[0] ?? null) as WorkspaceSnapshot | null);
      }),
      window.plasmaEvents.on('plasma:datafile:dropped', (...args: unknown[]) => {
        handleDroppedDataFiles(args[0] as DataFilePickResult);
      }),
      window.plasmaEvents.on('plasma:launch:action', (...args: unknown[]) => {
        void useWorkspace.getState().handleLaunch(args[0] as LaunchAction);
      }),
      // AI streaming deltas. Cast on receipt — preload sends raw IPC
      // payloads typed as unknown[] through the generic on() facade.
      window.plasmaEvents.on('plasma:ai:event', (...args: unknown[]) => {
        const evt = args[0] as Parameters<
          ReturnType<typeof useSession.getState>['aiApplyEvent']
        >[0];
        // One-shot tasks (Fix with AI, Explain plan, NL filter) own their streams.
        if (routeAiTaskEvent(evt)) return;
        session().aiApplyEvent(evt);
      }),
      // U26: stream Postgres NOTICE / RAISE NOTICE into the origin tab.
      window.plasmaEvents.on('plasma:pg:notice', (...args: unknown[]) => {
        const notice = args[0] as Parameters<
          ReturnType<typeof useSession.getState>['appendPgNotice']
        >[0];
        session().appendPgNotice(notice);
      }),
      // U20: the worker died and came back with no DB session — stop
      // claiming to be connected so the user gets the connect screen.
      window.plasmaEvents.on('plasma:worker:reset', () => {
        // Remember what we were connected to before the reset forgets it,
        // then retry with backoff (or wait for a click if auto is off).
        const prev = session().activeConfig;
        session().handleWorkerReset();
        if (prev?.id && session().savedConnections.some((c) => c.id === prev.id)) {
          useReconnect.getState().start({ id: prev.id, name: prev.name }, 'lost');
        }
      }),
      // U27: main rebuilt the session after a network/VPN drop. Adopt the
      // new connection generation so edit + result guards stay honest.
      window.plasmaEvents.on('plasma:conn:recovered', (...args: unknown[]) => {
        const parsed = ConnectionRecovered.safeParse(args[0]);
        if (parsed.success) session().handleConnectionRecovered(parsed.data);
      }),
    ];
    // Network back (Wi-Fi, VPN, wake from sleep) → retry right away
    // instead of waiting out the backoff.
    const onOnline = () => {
      const r = useReconnect.getState();
      if (r.target && (r.phase === 'waiting' || r.phase === 'failed')) void r.reconnectNow();
    };
    window.addEventListener('online', onOnline);
    return () => {
      for (const fn of unsub) fn();
      window.removeEventListener('online', onOnline);
    };
  }, []);

  return (
    <ErrorBoundary>
      <AppShell />
      <HostKeyDialog />
      <WorkspaceDialogs />
      <DataFilesDialogs />
      <TooltipLayer />
    </ErrorBoundary>
  );
}
