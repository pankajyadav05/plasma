import { cn } from '@/lib/cn';
import { type Side, placeTooltip } from '@/lib/tooltip-position';
import * as React from 'react';
import { createPortal } from 'react-dom';

/**
 * Hover/focus tooltip for icon-only chrome controls.
 *
 * Native `title` tooltips are painted by the browser at the pointer and,
 * for a control near a window edge, land on top of the control itself —
 * the icon disappears behind the tip and the button reads as unclickable
 * (reported for the tab/panel Close buttons).
 *
 * This component fixes that structurally:
 *   - the tip is positioned fully outside the trigger rect (see
 *     `placeTooltip`), flipping sides instead of covering the target;
 *   - it is `pointer-events-none`, so it can never swallow a click even
 *     if a future layout puts it over something interactive;
 *   - it hides on pointerdown, scroll, Escape and window blur, so the tip
 *     is gone the instant the user commits to clicking.
 *
 * The trigger keeps its own `aria-label`; the tip is decorative
 * (`aria-hidden`) so screen readers don't read the label twice.
 */
export interface TooltipProps {
  /** Tip text, e.g. "Close". */
  label: string;
  /** Optional shortcut rendered as a dim suffix, e.g. "Esc". */
  shortcut?: string;
  /** Preferred side; flips automatically when it doesn't fit. */
  side?: Side;
  /** Hover dwell before showing. Focus shows immediately. */
  delayMs?: number;
  children: React.ReactNode;
}

export function Tooltip({
  label,
  shortcut,
  side = 'bottom',
  delayMs = 350,
  children,
}: TooltipProps) {
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null);
  const triggerRef = React.useRef<HTMLSpanElement>(null);
  const tipRef = React.useRef<HTMLDivElement>(null);
  const timer = React.useRef<number | null>(null);

  const hide = React.useCallback(() => {
    window.clearTimeout(timer.current ?? undefined);
    timer.current = null;
    setOpen(false);
    setPos(null);
  }, []);

  const show = React.useCallback((delay: number) => {
    window.clearTimeout(timer.current ?? undefined);
    if (delay <= 0) {
      timer.current = null;
      setOpen(true);
      return;
    }
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setOpen(true);
    }, delay);
  }, []);

  React.useEffect(() => hide, [hide]);

  // Measure after paint, then place. Two-pass so the tip's real size
  // drives the side choice rather than a guess.
  React.useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current?.getBoundingClientRect();
    const tip = tipRef.current?.getBoundingClientRect();
    if (!trigger || !tip) return;
    const placement = placeTooltip({
      trigger: {
        left: trigger.left,
        top: trigger.top,
        width: trigger.width,
        height: trigger.height,
      },
      tip: { width: tip.width, height: tip.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      side,
    });
    setPos({ left: placement.left, top: placement.top });
  }, [open, side]);

  // Anything that moves the trigger or starts an interaction kills the tip.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    window.addEventListener('blur', hide);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
      window.removeEventListener('blur', hide);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, hide]);

  return (
    <span
      ref={triggerRef}
      className="inline-flex"
      onPointerEnter={(e) => {
        if (e.pointerType === 'touch') return;
        show(delayMs);
      }}
      onPointerLeave={hide}
      onPointerDown={hide}
      onFocus={(e) => {
        // Keyboard focus only. A mouse click focuses the button too, and
        // popping the tip open under the pointer right after the click is
        // exactly the flicker this component exists to avoid.
        if (e.target instanceof HTMLElement && e.target.matches(':focus-visible')) show(0);
      }}
      onBlur={hide}
    >
      {children}
      {open &&
        createPortal(
          <div
            ref={tipRef}
            role="tooltip"
            aria-hidden="true"
            style={{
              left: pos?.left ?? 0,
              top: pos?.top ?? 0,
              visibility: pos ? 'visible' : 'hidden',
            }}
            className={cn(
              'pointer-events-none fixed z-[60] select-none whitespace-nowrap rounded-md border border-border',
              'bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md',
            )}
          >
            {label}
            {shortcut && <span className="ml-1.5 font-mono text-muted-foreground">{shortcut}</span>}
          </div>,
          document.body,
        )}
    </span>
  );
}
