import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Kbd } from '@/components/ui/kbd';
import { cheatSheetSections, formatChord } from '@shared/keymap';

/**
 * ⌘/-driven cheat-sheet. Rows come from `KEYMAP` so the dialog cannot
 * drift from the live bindings.
 */
export function ShortcutCheatSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const isMac = typeof window !== 'undefined' && window.plasma?.platform === 'darwin';
  const sections = cheatSheetSections();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Every chord Plasma listens for. Press Esc to close.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-5">
          {sections.map((section) => (
            <div key={section.category}>
              <h3 className="mb-2 font-display text-sm italic text-muted-foreground">
                {section.category}
              </h3>
              <ul className="flex flex-col gap-1.5">
                {section.items.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-center justify-between gap-4 rounded-md px-1 py-1 text-sm"
                  >
                    <span className="text-foreground">{item.label}</span>
                    <Kbd className="shrink-0">{formatChord(item.chord, isMac)}</Kbd>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
