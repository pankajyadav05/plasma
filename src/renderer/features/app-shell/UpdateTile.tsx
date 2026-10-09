import { cn } from '@/lib/cn';
import { useUpdate } from '@/lib/use-update';
import type { UpdateStatus } from '@shared/protocol';
import { AlertTriangle, Download, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ProgressRing } from './UpdateBadge';

/** How long "Up to date" stays on the tile after a check the user started. */
const UP_TO_DATE_MS = 4000;

interface View {
  icon: React.ReactNode;
  label: string;
  title: string;
  /** The tile does something when clicked. */
  action: 'check' | 'install' | null;
  accent?: boolean;
  warn?: boolean;
}

export function viewFor(status: UpdateStatus, justChecked: boolean): View {
  switch (status.kind) {
    case 'checking':
      return {
        icon: <RefreshCw className="animate-spin" />,
        label: 'Checking…',
        title: 'Checking for updates',
        action: null,
      };
    case 'available':
      return {
        icon: <ProgressRing percent={null} size={22} />,
        label: 'Found',
        title: `Plasma ${status.version} found. Downloading.`,
        action: null,
      };
    case 'downloading': {
      const pct = Math.round(status.percent);
      return {
        icon: <ProgressRing percent={pct} size={22} />,
        label: `${pct}%`,
        title: `Downloading the update, ${pct}%`,
        action: null,
      };
    }
    case 'downloaded':
      return {
        icon: <RefreshCw />,
        label: 'Restart',
        title: `Restart to update to Plasma ${status.version}`,
        action: 'install',
        accent: true,
      };
    case 'restarting':
      return {
        icon: <RefreshCw className="animate-spin" />,
        label: 'Restarting',
        title: `Restarting to install Plasma ${status.version}`,
        action: null,
        accent: true,
      };
    case 'available-manual':
      return {
        icon: <Download />,
        label: 'Update',
        title: `Download Plasma ${status.version}${status.reason ? `. ${status.reason}` : ''}`,
        action: 'install',
        accent: true,
      };
    case 'error':
      return {
        icon: <AlertTriangle />,
        label: 'Retry',
        title: `${status.message}. Click to check again.`,
        action: 'check',
        warn: true,
      };
    case 'not-available':
      return {
        icon: <RefreshCw />,
        label: justChecked ? 'Up to date' : 'Updates',
        title: `Plasma ${status.version} is the latest version. Click to check again.`,
        action: 'check',
      };
    default:
      return { icon: <RefreshCw />, label: 'Updates', title: 'Check for updates', action: 'check' };
  }
}

/**
 * Rail tile above Settings: click to check for updates. A found update
 * downloads by itself (progress on the tile), then the tile turns into
 * "Restart"; one click installs, and main asks first when something
 * unsaved would be lost. Same updater as the top-bar badge and Settings.
 */
export function UpdateTile() {
  const { status, check, install } = useUpdate();
  const [checkedByUser, setCheckedByUser] = useState(false);
  const [justChecked, setJustChecked] = useState(false);

  // "Up to date" for a moment after a check the user asked for.
  useEffect(() => {
    if (!checkedByUser || status.kind === 'checking') return;
    setCheckedByUser(false);
    if (status.kind !== 'not-available') return;
    setJustChecked(true);
    const t = setTimeout(() => setJustChecked(false), UP_TO_DATE_MS);
    return () => clearTimeout(t);
  }, [checkedByUser, status.kind]);

  const view = viewFor(status, justChecked);
  const onClick = () => {
    if (view.action === 'check') {
      setCheckedByUser(true);
      void check();
    } else if (view.action === 'install') {
      void install();
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={view.action === null}
      aria-label={view.title}
      title={view.title}
      data-testid="rail-update"
      data-state={status.kind}
      className={cn(
        'flex w-[71px] flex-col items-center gap-[5px] rounded-[8px] px-1 pb-2 pt-2.5 transition-colors',
        '[&_svg]:h-[22px] [&_svg]:w-[22px] [&_svg]:stroke-[1.6]',
        'disabled:cursor-default',
        view.accent
          ? 'bg-[var(--wb-accent-fill)] text-white hover:bg-[color-mix(in_oklab,var(--wb-accent-fill)_88%,black)]'
          : view.warn
            ? 'text-[var(--status-warn)] hover:bg-[color-mix(in_oklab,var(--wb-window)_94%,var(--wb-text))]'
            : 'text-[var(--wb-text-2)] enabled:hover:bg-[color-mix(in_oklab,var(--wb-window)_94%,var(--wb-text))] enabled:hover:text-[var(--wb-text)]',
      )}
    >
      {view.icon}
      <span
        aria-live="polite"
        className={cn(
          'w-full truncate text-center text-[11px] font-medium leading-[13px] tabular-nums',
          view.accent
            ? 'text-white'
            : view.warn
              ? 'text-[var(--status-warn)]'
              : 'text-[var(--wb-text-2)]',
        )}
      >
        {view.label}
      </span>
    </button>
  );
}
