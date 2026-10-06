import { openExternal, releaseNotesUrl, useUpdateToasts } from '@/stores/update-toasts';
import type { UpdateLaunchInfo } from '@shared/protocol';
import { parseWorkspaceConnectionId } from '@shared/workspace';

/**
 * The toast after an update restart: "Updated to Plasma 3.2.2 · What's new",
 * or "The update could not be installed" with the log path and the manual
 * download. Nothing for a launch that was not an update restart.
 */
export function announceUpdateOutcome(
  info: UpdateLaunchInfo | null,
  push: ReturnType<typeof useUpdateToasts.getState>['push'] = useUpdateToasts.getState().push,
  open: (url: string) => void = openExternal,
): void {
  if (info == null || info.outcome === 'none' || info.version == null) return;
  if (info.outcome === 'updated') {
    const notes = releaseNotesUrl(info.version);
    push(
      {
        id: `updated-${info.version}`,
        tone: 'info',
        title: `Updated to Plasma ${info.version}`,
        actions: notes ? [{ label: 'What’s new', run: () => open(notes) }] : [],
      },
      12_000,
    );
    return;
  }
  const url = info.downloadUrl;
  push({
    id: `update-failed-${info.version}`,
    tone: 'warn',
    title: 'The update could not be installed',
    detail: `Plasma ${info.version} did not install, so you are still on the old version.${
      info.logPath ? ` Details: ${info.logPath}` : ''
    }`,
    actions: url ? [{ label: 'Download manually', run: () => open(url) }] : [],
  });
}

export type ResumePlan =
  /** A saved connection: reconnect through the reconnect machine. */
  | { kind: 'saved'; id: string; name: string }
  /** A team-workspace profile (`ws:<workspace>:<profile>`): reconnect through the workspace store. */
  | { kind: 'workspace'; connectionId: string; profileId: string }
  | null;

/**
 * How to bring the connection back after an update restart. Workspace profiles
 * are not in `savedConnections`; main reopened their workspace before the
 * renderer started, so the snapshot knows them.
 */
export function planResume(
  info: UpdateLaunchInfo | null,
  savedConnections: readonly { id: string; name: string }[],
  workspaceProfileIds: readonly string[],
): ResumePlan {
  if (!info?.resume || !info.connectionId) return null;
  const saved = savedConnections.find((c) => c.id === info.connectionId);
  if (saved) return { kind: 'saved', id: saved.id, name: saved.name };
  const ws = parseWorkspaceConnectionId(info.connectionId);
  if (ws && workspaceProfileIds.includes(ws.profileId)) {
    return { kind: 'workspace', connectionId: info.connectionId, profileId: ws.profileId };
  }
  return null;
}
