import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { MenuItem } from '@/components/ui/workbench';
import { useEffect, useRef } from 'react';

export type GridMenuEntry =
  | {
      kind: 'item';
      label: string;
      hint?: string;
      icon?: React.ReactNode;
      disabled?: boolean;
      onSelect: () => void;
    }
  | { kind: 'separator' }
  | { kind: 'heading'; label: string };

/**
 * Right-click menu for the result grid, anchored at the pointer. Arrow
 * keys move between items (roving focus); Esc closes and returns focus
 * to the grid.
 */
export function GridContextMenu({
  at,
  entries,
  onClose,
}: {
  at: { x: number; y: number } | null;
  entries: GridMenuEntry[];
  onClose: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!at) return;
    const id = requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [at]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const items = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
    );
    if (items.length === 0) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? items.length - 1
          : e.key === 'ArrowDown'
            ? (i + 1) % items.length
            : (i - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <Popover open={Boolean(at)} onOpenChange={(o) => !o && onClose()}>
      <PopoverAnchor asChild>
        <span
          aria-hidden
          style={{ position: 'fixed', left: at?.x ?? 0, top: at?.y ?? 0, width: 0, height: 0 }}
        />
      </PopoverAnchor>
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={2}
        className="w-[248px] p-1"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <div ref={listRef} role="menu" aria-label="Cell actions" onKeyDown={onKeyDown}>
          {entries.map((entry, i) => {
            if (entry.kind === 'separator') {
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: static menu layout
                <hr key={`sep-${i}`} className="my-1 h-px border-0 bg-[var(--wb-separator)]" />
              );
            }
            if (entry.kind === 'heading') {
              return (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: static menu layout
                  key={`h-${i}`}
                  className="px-2 pb-0.5 pt-1.5 text-[12px] font-medium text-[var(--wb-text-2)]"
                >
                  {entry.label}
                </div>
              );
            }
            return (
              <MenuItem
                // biome-ignore lint/suspicious/noArrayIndexKey: static menu layout
                key={`i-${i}`}
                icon={entry.icon}
                label={entry.label}
                hint={entry.hint}
                disabled={entry.disabled}
                onClick={() => {
                  onClose();
                  entry.onSelect();
                }}
              />
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
