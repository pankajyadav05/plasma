import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Kbd } from '@/components/ui/kbd';
import { isMac } from '@/lib/platform';
import { cheatSheetSections, formatBinding } from '@shared/keymap';
import { Search } from 'lucide-react';
import { useState } from 'react';

/**
 * ⌘/ cheat-sheet. Every row comes from `KEYMAP` — dispatched chords and
 * the documented grid / results / view keys alike — so the sheet can't
 * drift from the live bindings (K4).
 */
export function ShortcutCheatSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = useState('');
  const sections = cheatSheetSections(query, isMac);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setQuery('');
        onOpenChange(o);
      }}
    >
      <DialogContent className="flex max-h-[80vh] max-w-lg flex-col">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Every key Plasma listens for. Press Esc to close.</DialogDescription>
        </DialogHeader>
        <div className="flex h-[26px] items-center gap-2 rounded-[6px] border border-[var(--wb-separator)] bg-[var(--wb-content)] px-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-[var(--wb-text-2)]" aria-hidden />
          <input
            aria-label="Search shortcuts"
            placeholder="Search shortcuts"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-[var(--wb-text)] outline-none placeholder:text-[var(--wb-text-2)]"
          />
        </div>
        <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1">
          {sections.length === 0 && (
            <p className="py-6 text-center text-[13px] text-[var(--wb-text-2)]">
              No shortcuts match.
            </p>
          )}
          {sections.map((section) => (
            <div key={section.category}>
              <h3 className="mb-1.5 text-[13px] font-semibold text-[var(--wb-text-2)]">
                {section.category}
              </h3>
              <ul className="flex flex-col">
                {section.items.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-center justify-between gap-4 rounded-[4px] px-1 py-1 text-[13px]"
                  >
                    <span className="text-[var(--wb-text)]">{item.label}</span>
                    <Kbd className="shrink-0">{formatBinding(item.id, isMac)}</Kbd>
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
