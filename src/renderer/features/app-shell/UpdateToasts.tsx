import { Button } from '@/components/ui/button';
import { useUpdate } from '@/lib/use-update';
import { openExternal, releaseNotesUrl, useUpdateToasts } from '@/stores/update-toasts';
import { AlertTriangle, CheckCircle2, X } from 'lucide-react';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';

/** Versions whose "ready" toast was already shown in this window. */
const announced = new Set<string>();

/**
 * Raises the one-time "Plasma 3.2.2 is ready" toast when a download finishes
 * and renders the updater's toast stack (also fed by the launch routine in
 * `App.tsx`). Polite live region; every action is a real button.
 */
export function UpdateToasts() {
  const { status, install } = useUpdate();
  const toasts = useUpdateToasts((s) => s.toasts);
  const push = useUpdateToasts((s) => s.push);
  const dismiss = useUpdateToasts((s) => s.dismiss);

  const readyVersion = status.kind === 'downloaded' ? status.version : null;
  useEffect(() => {
    if (readyVersion == null || announced.has(readyVersion)) return;
    announced.add(readyVersion);
    const id = `ready-${readyVersion}`;
    const notes = releaseNotesUrl(readyVersion);
    push(
      {
        id,
        tone: 'info',
        title: `Plasma ${readyVersion} is ready`,
        detail: 'Restart to update. Your open SQL tabs are saved and come back.',
        actions: [
          {
            label: 'Restart to update',
            run: () => {
              dismiss(id);
              void install();
            },
          },
          ...(notes ? [{ label: 'What’s new', run: () => openExternal(notes) }] : []),
        ],
      },
      30_000,
    );
  }, [readyVersion, push, dismiss, install]);

  if (toasts.length === 0) return null;
  return createPortal(
    <output
      aria-live="polite"
      className="no-drag pointer-events-none fixed bottom-4 right-4 z-[80] flex w-[340px] flex-col gap-2"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex flex-col gap-2 rounded-[8px] bg-[var(--wb-content)] p-3 text-[var(--wb-text)] shadow-[0_6px_24px_rgba(0,0,0,0.18),inset_0_0_0_1px_var(--wb-toolbar-group-edge)]"
        >
          <div className="flex items-start gap-2">
            {t.tone === 'warn' ? (
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--status-warn)]" />
            ) : (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--wb-accent)]" />
            )}
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">{t.title}</div>
              {t.detail && (
                <div className="mt-0.5 break-words text-[12px] text-[var(--wb-text-2)]">
                  {t.detail}
                </div>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Dismiss"
              onClick={() => dismiss(t.id)}
            >
              <X />
            </Button>
          </div>
          {t.actions.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pl-6">
              {t.actions.map((a) => (
                <Button
                  key={a.label}
                  size="xs"
                  variant={a === t.actions[0] ? 'secondary' : 'ghost'}
                  onClick={a.run}
                >
                  {a.label}
                </Button>
              ))}
            </div>
          )}
        </div>
      ))}
    </output>,
    document.body,
  );
}
