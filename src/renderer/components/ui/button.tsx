import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

/**
 * Button — the primary interactive primitive.
 *
 * Variants match the Paper Editor language:
 *   primary     — ink bg, cream text, oxblood offset shadow (max 1 per screen)
 *   secondary   — cream canvas, ink border, subtle hover
 *   outline     — transparent, muted border, accent on hover
 *   ghost       — transparent, no border, accent on hover (toolbars)
 *   destructive — transparent → oxblood fill on hover
 *   link        — accent-colored underline on hover
 *
 * Size scale is tight and consistent:
 *   xs         24px tall, minimal padding
 *   sm         28px
 *   default    34px
 *   lg         42px (sheet CTAs)
 *   icon       32px square
 *   icon-sm    28px square
 *   icon-xs    24px square
 */
const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap font-sans font-medium",
    "transition-all duration-instant",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-paper",
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        primary: [
          "bg-ink text-paper rounded-sm border-0",
          "shadow-offset-md",
          "hover:translate-x-px hover:translate-y-px hover:shadow-[2px_2px_0_0_var(--accent)]",
          "active:translate-x-0.5 active:translate-y-0.5 active:shadow-[1px_1px_0_0_var(--accent)]",
        ],
        secondary: ["rounded-sm border border-border-strong bg-paper-canvas text-ink", "hover:bg-[var(--bg-hover)]"],
        outline: [
          "rounded-sm border border-border-soft bg-transparent text-ink-2",
          "hover:border-accent hover:bg-[var(--bg-hover)] hover:text-accent",
        ],
        ghost: [
          "rounded-sm border border-transparent bg-transparent text-ink-2",
          "hover:bg-[var(--bg-hover)] hover:text-accent",
        ],
        destructive: ["rounded-sm border border-accent bg-transparent text-accent", "hover:bg-accent hover:text-paper"],
        link: ["rounded-sm border-0 bg-transparent text-accent underline-offset-4", "hover:underline"],
      },
      size: {
        xs: "h-6 px-2 text-xs uppercase tracking-[0.06em] [&_svg]:h-3 [&_svg]:w-3",
        sm: "h-7 px-2.5 text-[13px] uppercase tracking-[0.05em] [&_svg]:h-3.5 [&_svg]:w-3.5",
        default: "h-8 px-3.5 text-[13px] uppercase tracking-[0.05em] [&_svg]:h-3.5 [&_svg]:w-3.5",
        lg: "h-[42px] px-5 text-[14px] uppercase tracking-[0.06em] [&_svg]:h-4 [&_svg]:w-4",
        icon: "h-8 w-8 p-0 [&_svg]:h-4 [&_svg]:w-4",
        "icon-sm": "h-7 w-7 p-0 [&_svg]:h-3.5 [&_svg]:w-3.5",
        "icon-xs": "h-6 w-6 p-0 [&_svg]:h-3.5 [&_svg]:w-3.5",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type = "button", ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
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
Button.displayName = "Button";

export { buttonVariants };
