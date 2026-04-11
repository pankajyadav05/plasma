import * as React from "react";
import { cn } from "@/lib/cn";

/**
 * Keyboard shortcut pill. Use inside tooltips, menu items, and
 * anywhere you display a keybinding.
 */
export const Kbd = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
  ({ className, children, ...props }, ref) => (
    <kbd
      ref={ref}
      className={cn(
        "inline-flex h-5 min-w-[20px] items-center justify-center rounded-sm border border-border-soft bg-paper-canvas px-1.5 font-mono text-xs text-ink-muted",
        className,
      )}
      {...props}
    >
      {children}
    </kbd>
  ),
);
Kbd.displayName = "Kbd";
