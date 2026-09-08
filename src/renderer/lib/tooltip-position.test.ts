import { describe, expect, it } from 'vitest';
import { type Rect, placeTooltip } from './tooltip-position';

const VIEWPORT = { width: 1280, height: 800 };
const TIP = { width: 96, height: 28 };

function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.left < b.left + b.width &&
    a.left + a.width > b.left &&
    a.top < b.top + b.height &&
    a.top + a.height > b.top
  );
}

describe('placeTooltip', () => {
  it('uses the preferred side when it fits', () => {
    const trigger = { left: 600, top: 40, width: 28, height: 28 };
    const p = placeTooltip({ trigger, tip: TIP, viewport: VIEWPORT, side: 'bottom' });
    expect(p.side).toBe('bottom');
    expect(p.top).toBe(40 + 28 + 8);
    expect(p.left).toBe(600 + 14 - 48);
  });

  it('flips to the opposite side when the preferred one has no room', () => {
    // Close button pinned to the bottom edge — the native tooltip lands on
    // top of it here; ours must go above.
    const trigger = { left: 600, top: 790, width: 28, height: 28 };
    const p = placeTooltip({ trigger, tip: TIP, viewport: VIEWPORT, side: 'bottom' });
    expect(p.side).toBe('top');
    expect(p.top).toBe(790 - 8 - TIP.height);
  });

  it('keeps the tip inside the viewport on the cross axis', () => {
    const trigger = { left: 1248, top: 8, width: 28, height: 28 };
    const p = placeTooltip({ trigger, tip: TIP, viewport: VIEWPORT, side: 'bottom' });
    expect(p.left).toBe(VIEWPORT.width - 8 - TIP.width);
    expect(p.left).toBeGreaterThanOrEqual(8);
  });

  it('never overlaps the trigger, including when no side has room', () => {
    const sides = ['top', 'bottom', 'left', 'right'] as const;
    const tips = [TIP, { width: 2000, height: 1200 }, { width: 40, height: 12 }];
    for (const left of [0, 4, 320, 1252, 1279]) {
      for (const top of [0, 4, 400, 772, 799]) {
        for (const tip of tips) {
          for (const side of sides) {
            const trigger = { left, top, width: 28, height: 28 };
            const p = placeTooltip({ trigger, tip, viewport: VIEWPORT, side });
            expect(
              overlaps({ left: p.left, top: p.top, ...tip }, trigger),
              `${side} @ ${left},${top} tip ${tip.width}x${tip.height}`,
            ).toBe(false);
          }
        }
      }
    }
  });

  it('falls back to a horizontal side when the tip is taller than the room above and below', () => {
    const trigger = { left: 100, top: 380, width: 28, height: 28 };
    const p = placeTooltip({
      trigger,
      tip: { width: 120, height: 900 },
      viewport: VIEWPORT,
      side: 'bottom',
    });
    expect(p.side).toBe('right');
    expect(p.left).toBe(100 + 28 + 8);
  });
});
