import { cn } from '@/lib/cn';
import * as React from 'react';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = 'text', ...props }, ref) => {
    return (
      <input
        type={type}
        ref={ref}
        className={cn(
          // Workbench field: 26px, radius 7, --wb-field fill, hairline ring.
          'flex h-[26px] w-full rounded-[7px] border-0 bg-[var(--wb-field)] px-2 py-0 text-[13px] text-[var(--wb-text)]',
          'shadow-[inset_0_0_0_1px_var(--wb-toolbar-group-edge)] transition-shadow',
          'placeholder:text-[var(--wb-text-3)]',
          'focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--ring),0_0_0_3px_color-mix(in_oklch,var(--ring)_30%,transparent)]',
          'aria-[invalid=true]:shadow-[inset_0_0_0_1px_var(--destructive)]',
          'disabled:cursor-not-allowed disabled:opacity-40',
          'file:border-0 file:bg-transparent file:text-[13px] file:font-medium',
          // Native number spinners are off-theme; typing / arrow keys still work.
          '[&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
          className,
        )}
        {...props}
      />
    );
  },
);
Input.displayName = 'Input';
