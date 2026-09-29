import { cn } from '@/lib/cn';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check } from 'lucide-react';
import * as React from 'react';

export const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      // 14px macOS-style box: field fill + hairline ring; checked is the
      // neutral "ink" fill (same as the primary button), never the accent.
      'peer grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[4px] bg-[var(--wb-field)]',
      'shadow-[inset_0_0_0_1px_var(--wb-toolbar-group-edge)]',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
      'disabled:cursor-not-allowed disabled:opacity-40',
      'data-[state=checked]:bg-[var(--wb-text)] data-[state=checked]:text-[var(--wb-content)] data-[state=checked]:shadow-none',
      'data-[state=indeterminate]:bg-[var(--wb-text)] data-[state=indeterminate]:text-[var(--wb-content)]',
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
      <Check className="h-2.5 w-2.5" strokeWidth={3.5} />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;
