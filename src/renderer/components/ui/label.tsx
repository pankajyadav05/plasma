import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "@/lib/cn";

/**
 * Form label. Defaults to the small monospace uppercase field label
 * style used throughout the Paper Editor forms.
 */
export const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn(
      "font-mono text-xs uppercase text-ink-muted",
      "peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
      className,
    )}
    style={{ letterSpacing: "0.06em" }}
    {...props}
  />
));
Label.displayName = LabelPrimitive.Root.displayName;
