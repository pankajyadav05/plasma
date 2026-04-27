import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { kbd } from '@/lib/platform';
import { useSession } from '@/stores/session';
import { SettingsBody } from './SettingsBody';

/**
 * Full-window settings page. Constrained-width column for readability;
 * close button (top-right) returns to the database canvas.
 */
export function SettingsCanvas() {
  const setCanvasMode = useSession((s) => s.setCanvasMode);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[640px] px-6 py-10">
          <header className="mb-6 flex items-start justify-between border-b border-border pb-4">
            <div>
              <h1 className="font-display text-2xl italic text-foreground">Settings</h1>
              <p className="font-display text-sm italic text-muted-foreground">
                Preferences persist in the local SQLite store.
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setCanvasMode('database')}
              aria-label="Close settings"
              title={`Close (${kbd('Esc')})`}
            >
              <X />
            </Button>
          </header>
          <SettingsBody />
        </div>
      </div>
    </div>
  );
}
