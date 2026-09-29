import { cn } from '@/lib/cn';
import * as React from 'react';

/**
 * Keyboard shortcut pill. Use inside tooltips, menu items, and
 * anywhere you display a keybinding.
 */
export const Kbd = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
  ({ className, children, ...props }, ref) => (
    <kbd
      ref={ref}
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] bg-[var(--wb-control)] px-1 font-sans text-[11px] leading-none text-[var(--wb-text-2)]',
        className,
      )}
      {...props}
    >
      {children}
    </kbd>
  ),
);
Kbd.displayName = 'Kbd';
