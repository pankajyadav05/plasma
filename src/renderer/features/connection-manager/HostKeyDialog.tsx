import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ipc } from '@/lib/ipc';
import type { SshHostKeyPrompt } from '@shared/protocol';
import { ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * C8 — SSH host-key confirmation. Main pushes a prompt when a bastion's
 * key is unknown (trust on first use) or has changed since it was
 * remembered (possible man-in-the-middle, so the warning is loud and the
 * safe answer is the default). Nothing connects until the user answers.
 */
export function HostKeyDialog() {
  const [queue, setQueue] = useState<SshHostKeyPrompt[]>([]);
  const prompt = queue[0] ?? null;

  useEffect(
    () =>
      window.plasmaEvents.on('plasma:ssh:hostKeyPrompt', (...args: unknown[]) => {
        const p = args[0] as SshHostKeyPrompt | undefined;
        if (p && typeof p.requestId === 'string') setQueue((q) => [...q, p]);
      }),
    [],
  );

  const answer = (accept: boolean) => {
    if (!prompt) return;
    void ipc.conn.respondHostKey(prompt.requestId, accept);
    setQueue((q) => q.slice(1));
  };

  const changed = prompt?.kind === 'changed';

  return (
    <Dialog open={prompt !== null} onOpenChange={(o) => !o && answer(false)}>
      <DialogContent className="max-w-[480px]" data-testid="ssh-host-key-dialog">
        {prompt && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {changed && <ShieldAlert className="h-4 w-4 text-[var(--destructive)]" />}
                {changed ? 'SSH host key has changed' : 'Unknown SSH host'}
              </DialogTitle>
              <DialogDescription>
                {changed ? (
                  <>
                    <span className="font-mono text-[var(--wb-text)]">
                      {prompt.host}:{prompt.port}
                    </span>{' '}
                    presented a different key than the one Plasma remembered. This can mean the
                    server was reinstalled — or that someone is intercepting the connection. Only
                    continue if the server's administrator confirms the new key.
                  </>
                ) : (
                  <>
                    Plasma has not connected to{' '}
                    <span className="font-mono text-[var(--wb-text)]">
                      {prompt.host}:{prompt.port}
                    </span>{' '}
                    before. Check the fingerprint with the server's administrator before trusting
                    it.
                  </>
                )}
              </DialogDescription>
            </DialogHeader>
            <dl className="grid gap-1.5 rounded-[6px] bg-[var(--wb-sidebar)] p-2.5 text-[12px]">
              {changed && prompt.expectedFingerprint && (
                <>
                  <dt className="text-[var(--wb-text-2)]">Remembered key</dt>
                  <dd className="break-all font-mono text-[var(--wb-text)]">
                    {prompt.expectedFingerprint}
                  </dd>
                </>
              )}
              <dt className="text-[var(--wb-text-2)]">{changed ? 'New key' : 'Fingerprint'}</dt>
              <dd
                className="break-all font-mono text-[var(--wb-text)]"
                data-testid="ssh-host-key-fingerprint"
              >
                {prompt.fingerprint}
              </dd>
            </dl>
            <DialogFooter>
              <Button variant="secondary" size="sm" autoFocus onClick={() => answer(false)}>
                {changed ? 'Cancel connection' : 'Cancel'}
              </Button>
              <Button
                variant={changed ? 'destructive' : 'primary'}
                size="sm"
                onClick={() => answer(true)}
                data-testid="ssh-host-key-trust"
              >
                {changed ? 'Trust the new key' : 'Trust and connect'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
