import { Button } from '@/components/ui/button';
import { ipc } from '@/lib/ipc';
import type { CliInstallStatus } from '@shared/deep-link';
import { Terminal } from 'lucide-react';
import { useEffect, useState } from 'react';

/** Settings → Advanced: install (macOS/Linux) or explain (Windows) the `plasma` command. */
export function CliToolField() {
  const [status, setStatus] = useState<CliInstallStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void ipc.cli.status().then(setStatus, () => setStatus(null));
  }, []);

  if (!status) return null;

  if (status.platform === 'win32') {
    return (
      <div data-testid="cli-tool">
        <pre className="whitespace-pre-wrap rounded-[6px] bg-[var(--wb-field)] p-2 font-mono text-[12px] text-[var(--wb-text-2)]">
          {status.instructions}
        </pre>
      </div>
    );
  }

  const install = async () => {
    setBusy(true);
    try {
      setStatus(await ipc.cli.install());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="cli-tool">
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => void install()} disabled={busy}>
          <Terminal />
          {status.installedAt ? 'Reinstall command-line tool' : 'Install command-line tool'}
        </Button>
        {status.installedAt && (
          <span className="truncate font-mono text-[12px] text-[var(--wb-text-2)]">
            {status.installedAt}
          </span>
        )}
      </div>
      {status.message && (
        <p className="mt-1 break-words text-[12px] text-[var(--wb-text-2)]">{status.message}</p>
      )}
    </div>
  );
}
