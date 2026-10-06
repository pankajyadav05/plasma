import type { UpdateStatus } from '@shared/protocol';

/**
 * Human text for the About panel's update line.
 *
 * `not-available` carries the version the *feed* advertises, not the
 * version the user is running. Those are normally identical, so the old
 * copy printed the feed's number as "you are on the latest version" —
 * which lies whenever the published manifest falls behind the installed
 * build (dead feed URL, failed publish job, stale CDN copy). A 0.0.19
 * user whose feed still reads 0.0.18 was told they were current at
 * v0.0.18. Compare the two and say what is actually true.
 */
export function describeUpdateStatus(status: UpdateStatus, appVersion: string): string {
  switch (status.kind) {
    case 'idle':
      return 'Click "Check now" to look for a new version.';
    case 'checking':
      return 'Checking for updates…';
    case 'not-available': {
      if (appVersion && compareVersions(status.version, appVersion) < 0) {
        return `Update feed is behind — it advertises v${status.version}, you are running v${appVersion}. Auto-update cannot reach you; download the current build from plasma.sh.`;
      }
      return `You are on the latest version (v${appVersion || status.version}).`;
    }
    case 'available':
      return `Update v${status.version} found — downloading in the background.`;
    case 'available-manual':
      return `Update v${status.version} is available. ${status.reason ?? 'Download it to update.'}`;
    case 'downloading':
      return `Downloading update — ${Math.round(status.percent)}% (${formatBytes(status.bytesPerSecond)}/s)`;
    case 'downloaded':
      return `Update v${status.version} is ready — restart to install.`;
    case 'restarting':
      return `Restarting to install v${status.version}…`;
    case 'error':
      return `Update problem: ${status.message}`;
  }
}

/** "just now", "5 minutes ago", "yesterday"; the date after that. */
export function describeCheckedAt(at: number | null, now: number): string {
  if (at == null) return 'not checked yet';
  const sec = Math.max(0, Math.round((now - at) / 1000));
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return new Date(at).toLocaleDateString();
}

/**
 * Numeric-segment version compare (`0.0.9` < `0.0.10`). Returns <0, 0, >0.
 * Any pre-release suffix is ignored: releases here are plain `x.y.z`, and
 * an unparseable segment sorts as 0 rather than throwing on a hostile feed.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number.parseInt(pa[i] ?? '0', 10) || 0;
    const nb = Number.parseInt(pb[i] ?? '0', 10) || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
