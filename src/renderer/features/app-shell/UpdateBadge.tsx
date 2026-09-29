import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useUpdate } from '@/lib/use-update';
import { Download, Loader2, RotateCw } from 'lucide-react';
import { useState } from 'react';

/**
 * Toolbar badge that surfaces auto-update state. Renders nothing
 * unless something interesting is happening (downloading or ready
 * to install). The Settings → About section handles all the manual
 * controls + the "no update available" wording.
 */
export function UpdateBadge() {
  const { status, install } = useUpdate();
  const [confirmInstall, setConfirmInstall] = useState(false);

  if (status.kind === 'downloading') {
    return (
      <span
        className="no-drag flex items-center gap-1.5 px-2 text-[12px] text-[var(--wb-text-2)]"
        title={`Downloading update — ${Math.round(status.percent)}%`}
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        <span className="tabular-nums">Downloading update {Math.round(status.percent)}%</span>
      </span>
    );
  }

  if (status.kind === 'downloaded') {
    return (
      <>
        <Button
          variant="secondary"
          size="pill"
          onClick={() => setConfirmInstall(true)}
          title={`Restart to install v${status.version}`}
          className="no-drag"
        >
          <Download />
          Update ready · v{status.version}
        </Button>
        <ConfirmDialog
          open={confirmInstall}
          onOpenChange={setConfirmInstall}
          title={`Install Plasma v${status.version}?`}
          description="Plasma will restart to apply the update. Copy or save any SQL you want to keep first."
          confirmLabel="Restart & install"
          variant="primary"
          onConfirm={() => void install()}
        />
      </>
    );
  }

  if (status.kind === 'available') {
    return (
      <span
        className="no-drag flex items-center gap-1.5 px-2 text-[12px] text-[var(--wb-text-2)]"
        title={`Update v${status.version} available — downloading…`}
      >
        <RotateCw className="h-3 w-3 animate-spin" />
        <span>Downloading v{status.version}…</span>
      </span>
    );
  }

  return null;
}
