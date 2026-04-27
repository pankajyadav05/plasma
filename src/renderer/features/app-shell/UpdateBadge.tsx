import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useUpdate } from '@/lib/use-update';
import { Download, Loader2, RotateCw } from 'lucide-react';
import { useState } from 'react';

/**
 * StatusBar pill that surfaces auto-update state. Renders nothing
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
        className="flex items-center gap-1.5 px-3 text-xs text-muted-foreground"
        title={`Downloading update — ${Math.round(status.percent)}%`}
      >
        <Loader2 className="h-3 w-3 animate-spin text-primary" />
        <span className="tabular-nums">downloading {Math.round(status.percent)}%</span>
      </span>
    );
  }

  if (status.kind === 'downloaded') {
    return (
      <>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setConfirmInstall(true)}
          title={`Restart to install v${status.version}`}
          className="border border-primary text-primary"
        >
          <Download className="h-3 w-3" />
          update ready · v{status.version}
        </Button>
        <ConfirmDialog
          open={confirmInstall}
          onOpenChange={setConfirmInstall}
          title={`Install Plasma v${status.version}?`}
          description="The app will restart to apply the update. Unsaved query tabs will be reopened automatically."
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
        className="flex items-center gap-1.5 px-3 text-xs text-muted-foreground"
        title={`Update v${status.version} available — downloading…`}
      >
        <RotateCw className="h-3 w-3 animate-spin text-primary" />
        <span>update v{status.version} downloading…</span>
      </span>
    );
  }

  return null;
}
