import { cn } from '@/lib/cn';
import { Slot } from '@radix-ui/react-slot';
import { type VariantProps, cva } from 'class-variance-authority';
import * as React from 'react';

/**
 * The one button style source for the app. Workbench chrome (`Pill`,
 * `IconButton` in `workbench.tsx`) renders through these same variants,
 * so forms, dialogs and toolbars share one look: 13px sans, compact
 * heights, `--wb-*` surfaces.
 *
 * - `primary`: the neutral "ink" button (one per dialog: Save, Connect,
 *   Run). Never the theme accent.
 * - `secondary`: the neutral control pill (Cancel, Test, Export…).
 * - `outline`: hairline ring, transparent fill.
 * - `ghost`: no fill until hover (icon buttons, toolbar actions).
 * - `destructive`: red fill with a lightness cap so white text stays AA.
 * - `link`: accent-coloured inline text.
 */
const buttonVariants = cva(
  [
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[6px] text-[13px] font-normal leading-none',
    'cursor-pointer transition-colors duration-100',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
    'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-40',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        primary:
          'bg-[var(--wb-text)] font-medium text-[var(--wb-content)] hover:bg-[color-mix(in_oklab,var(--wb-text)_86%,var(--wb-content))]',
        secondary:
          'bg-[var(--wb-control)] text-[var(--wb-text)] hover:bg-[var(--wb-control-hover)]',
        outline:
          'bg-transparent text-[var(--wb-text)] shadow-[inset_0_0_0_1px_var(--wb-toolbar-group-edge)] hover:bg-[var(--wb-control-hover)]',
        ghost:
          'bg-transparent text-[var(--wb-text-2)] hover:bg-[var(--wb-control-hover)] hover:text-[var(--wb-text)]',
        destructive:
          'bg-[var(--wb-danger-fill)] font-medium text-white hover:bg-[color-mix(in_oklab,var(--wb-danger-fill)_88%,black)]',
        link: 'h-auto px-0 text-[var(--wb-accent-text)] underline-offset-4 hover:underline',
      },
      size: {
        xs: 'h-[22px] px-2 text-[12px] [&_svg]:h-3 [&_svg]:w-3',
        sm: 'h-6 px-2.5 [&_svg]:h-3.5 [&_svg]:w-3.5',
        default: 'h-7 px-3 [&_svg]:h-3.5 [&_svg]:w-3.5',
        lg: 'h-8 px-4 [&_svg]:h-4 [&_svg]:w-4',
        /** Workbench pill — same box as `Pill` (24px, radius 6). */
        pill: 'h-6 shrink-0 px-2.5 [&_svg]:h-3.5 [&_svg]:w-3.5',
        icon: 'h-7 w-7 [&_svg]:h-4 [&_svg]:w-4',
        'icon-sm': 'h-6 w-6 [&_svg]:h-3.5 [&_svg]:w-3.5',
        /** Workbench icon button — same box as `IconButton` (24px square). */
        'icon-24': 'h-6 w-6 shrink-0 [&_svg]:h-3.5 [&_svg]:w-3.5',
        'icon-xs': 'h-[22px] w-[22px] [&_svg]:h-3 [&_svg]:w-3',
      },
    },
    defaultVariants: {
      variant: 'secondary',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type = 'button', ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size }), className)}
        ref={ref}
        {...(asChild ? {} : { type })}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';

export { buttonVariants };
