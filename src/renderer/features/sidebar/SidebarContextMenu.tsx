import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { MenuItem } from '@/components/ui/workbench';
import { cn } from '@/lib/cn';

export type MenuEntry =
  | {
      type: 'item';
      label: string;
      icon?: React.ReactNode;
      hint?: string;
      disabled?: boolean;
      destructive?: boolean;
      onSelect: () => void;
    }
  | { type: 'separator' }
  | { type: 'label'; label: string };

export interface ContextMenuState {
  x: number;
  y: number;
  entries: MenuEntry[];
}

/**
 * Right-click menu for sidebar rows (PC3). A Popover anchored at the
 * pointer so it shares the workbench popover chrome and MenuItem rows
 * with the other sidebar menus. ↑/↓ move between items; Esc closes.
 */
export function SidebarContextMenu({
  state,
  onClose,
}: {
  state: ContextMenuState | null;
  onClose: () => void;
}) {
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const items = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'),
    );
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = 0;
    if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'ArrowDown') next = at === -1 ? 0 : (at + 1) % items.length;
    else if (e.key === 'ArrowUp') next = at <= 0 ? items.length - 1 : at - 1;
    items[next]?.focus();
  };

  return (
    <Popover open={state !== null} onOpenChange={(open) => !open && onClose()}>
      <PopoverAnchor asChild>
        <div
          aria-hidden
          style={{
            position: 'fixed',
            left: state?.x ?? 0,
            top: state?.y ?? 0,
            width: 0,
            height: 0,
          }}
        />
      </PopoverAnchor>
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={2}
        className="w-[240px] p-1"
        role="menu"
        data-testid="sidebar-context-menu"
        onKeyDown={onKeyDown}
        onOpenAutoFocus={(e) => {
          // Focus the first item so the keyboard works straight away.
          e.preventDefault();
          const el = e.currentTarget as HTMLElement | null;
          el?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
        }}
      >
        {state?.entries.map((entry, i) => {
          if (entry.type === 'separator') {
            return (
              <hr
                // biome-ignore lint/suspicious/noArrayIndexKey: static menu layout
                key={`sep-${i}`}
                className="my-1 h-px border-0 bg-[var(--wb-separator)]"
              />
            );
          }
          if (entry.type === 'label') {
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: static menu layout
                key={`label-${i}`}
                className="px-2 pb-0.5 pt-1 text-[11px] text-[var(--wb-text-3)]"
              >
                {entry.label}
              </div>
            );
          }
          return (
            <MenuItem
              // biome-ignore lint/suspicious/noArrayIndexKey: labels may repeat across groups
              key={`item-${i}`}
              icon={entry.icon}
              hint={entry.hint}
              disabled={entry.disabled}
              label={
                entry.destructive ? (
                  <span
                    className={cn(
                      'text-destructive group-hover/menu:text-white group-focus-visible/menu:text-white',
                    )}
                  >
                    {entry.label}
                  </span>
                ) : (
                  entry.label
                )
              }
              onClick={() => {
                onClose();
                entry.onSelect();
              }}
            />
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
