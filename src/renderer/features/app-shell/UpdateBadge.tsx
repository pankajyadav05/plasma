import { Button } from '@/components/ui/button';
import { useUpdate } from '@/lib/use-update';
import { AlertTriangle, Download, Loader2, RefreshCw } from 'lucide-react';
import { useState } from 'react';

/**
 * Top-bar update control. Quiet until something needs the user:
 *
 * - downloading: a small progress ring (fixed size, so nothing jitters);
 * - downloaded: an accent pill "Restart to update". One click restarts at
 *   once; when something would be lost (pending edits, an open transaction,
 *   a running query...) main lists it and asks first;
 * - cannot self-install (portable, .deb, a Mac app outside Applications):
 *   an "Update" pill that opens the download, the reason in its tooltip;
 * - error: a muted warning icon; the message and "Try again" in its tooltip.
 *
 * Settings → Updates carries the same actions with the full status line.
 */
export function UpdateBadge() {
  const { status, install, check } = useUpdate();
  const [working, setWorking] = useState(false);

  const restart = async () => {
    setWorking(true);
    try {
      await install();
    } finally {
      setWorking(false);
    }
  };

  if (status.kind === 'downloading' || status.kind === 'available') {
    const percent = status.kind === 'downloading' ? Math.round(status.percent) : null;
    const label =
      status.kind === 'available'
        ? `Update v${status.version} found, downloading`
        : `Downloading update, ${percent}%`;
    const className =
      'no-drag flex h-6 w-6 shrink-0 items-center justify-center text-[var(--wb-text-2)]';
    return (
      <span role="img" aria-label={label} title={label} className={className}>
        <ProgressRing percent={percent} />
      </span>
    );
  }

  if (status.kind === 'downloaded' || status.kind === 'restarting') {
    const restarting = status.kind === 'restarting' || working;
    return (
      <Button
        size="pill"
        disabled={restarting}
        onClick={() => void restart()}
        title={`Restart to install Plasma v${status.version}`}
        aria-label={`Restart to update to Plasma ${status.version}`}
        className="no-drag bg-[var(--wb-accent-fill)] font-medium text-white hover:bg-[color-mix(in_oklab,var(--wb-accent-fill)_88%,black)]"
      >
        {restarting ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        {restarting ? 'Restarting…' : 'Restart to update'}
      </Button>
    );
  }

  if (status.kind === 'available-manual') {
    return (
      <Button
        size="pill"
        variant="outline"
        onClick={() => void install()}
        title={`Download Plasma v${status.version}${status.reason ? `. ${status.reason}` : ''}`}
        aria-label={`Download Plasma ${status.version}`}
        className="no-drag text-[var(--wb-accent-text)]"
      >
        <Download />
        Update
      </Button>
    );
  }

  if (status.kind === 'error') {
    return (
      <Button
        size="icon-24"
        variant="ghost"
        onClick={() => void check()}
        title={`${status.message} — click to try again`}
        aria-label={`Update problem: ${status.message}. Try again`}
        className="no-drag text-[var(--status-warn)]"
      >
        <AlertTriangle />
      </Button>
    );
  }

  return null;
}

/** 16px ring; a spinning arc when the percentage is not known yet. */
function ProgressRing({ percent }: { percent: number | null }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  const value = percent == null ? 25 : Math.max(2, Math.min(100, percent));
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
      className={percent == null ? 'animate-spin' : undefined}
    >
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="2"
      />
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        stroke="var(--wb-accent)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={`${(c * value) / 100} ${c}`}
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}
