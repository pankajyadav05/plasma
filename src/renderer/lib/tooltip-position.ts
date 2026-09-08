/**
 * Tooltip placement math.
 *
 * The invariant this module exists for: a tooltip must never be drawn on
 * top of the control it describes. Native `title` tooltips are painted at
 * the pointer and flip over the hovered element near a window edge, which
 * hides the target (and, for icon-only chrome buttons, makes it feel
 * unclickable). We place our own tooltip fully outside the trigger rect.
 *
 * Kept DOM-free so it is unit-testable in the Node test environment.
 */

export type Side = 'top' | 'bottom' | 'left' | 'right';

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Placement {
  left: number;
  top: number;
  side: Side;
}

export interface PlaceTooltipOptions {
  /** Trigger bounding box in viewport coordinates. */
  trigger: Rect;
  /** Measured tooltip box. */
  tip: Size;
  viewport: Size;
  /** Preferred side; used when it fits. */
  side?: Side;
  /** Gap between the trigger edge and the tooltip edge. */
  gap?: number;
  /** Minimum distance kept from the viewport edges. */
  margin?: number;
}

const OPPOSITE: Record<Side, Side> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
};

/**
 * Resolve a viewport-coordinate position for the tooltip.
 *
 * - The tooltip is always placed on one of the four sides, offset by `gap`,
 *   so it never intersects `trigger`.
 * - The preferred side wins when it fits; otherwise the opposite side, then
 *   whichever remaining side has the most room. When nothing fits the side
 *   with the largest slack is used and the tooltip is allowed to bleed past
 *   the viewport edge — overlapping the trigger is never traded for it.
 * - The cross axis is centred on the trigger and clamped into the viewport,
 *   which cannot reintroduce an overlap because the main axis is outside.
 */
export function placeTooltip({
  trigger,
  tip,
  viewport,
  side = 'bottom',
  gap = 8,
  margin = 8,
}: PlaceTooltipOptions): Placement {
  const space: Record<Side, number> = {
    top: trigger.top - margin,
    bottom: viewport.height - (trigger.top + trigger.height) - margin,
    left: trigger.left - margin,
    right: viewport.width - (trigger.left + trigger.width) - margin,
  };
  const need = (s: Side) => (s === 'top' || s === 'bottom' ? tip.height : tip.width) + gap;

  const opposite = OPPOSITE[side];
  const rest = (['top', 'bottom', 'left', 'right'] as Side[])
    .filter((s) => s !== side && s !== opposite)
    .sort((a, b) => space[b] - space[a]);
  const order: Side[] = [side, opposite, ...rest];

  let chosen = order.find((s) => space[s] >= need(s));
  if (!chosen) {
    chosen = order.reduce((best, s) => (space[s] - need(s) > space[best] - need(best) ? s : best));
  }

  if (chosen === 'top' || chosen === 'bottom') {
    const top =
      chosen === 'top' ? trigger.top - gap - tip.height : trigger.top + trigger.height + gap;
    const centred = trigger.left + trigger.width / 2 - tip.width / 2;
    const left = Math.min(
      Math.max(centred, margin),
      Math.max(margin, viewport.width - margin - tip.width),
    );
    return { left, top, side: chosen };
  }

  const left =
    chosen === 'left' ? trigger.left - gap - tip.width : trigger.left + trigger.width + gap;
  const centred = trigger.top + trigger.height / 2 - tip.height / 2;
  const top = Math.min(
    Math.max(centred, margin),
    Math.max(margin, viewport.height - margin - tip.height),
  );
  return { left, top, side: chosen };
}
