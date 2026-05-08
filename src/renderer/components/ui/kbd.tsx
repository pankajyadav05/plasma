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
        'inline-flex h-5 min-w-[20px] items-center justify-center rounded-sm border border-border bg-card px-1.5 font-mono text-xs text-muted-foreground',
        className,
      )}
      {...props}
    >
      {children}
    </kbd>
  ),
);
Kbd.displayName = 'Kbd';
