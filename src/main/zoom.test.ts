import { describe, expect, it, vi } from 'vitest';

vi.mock('./settings', () => ({ getSetting: vi.fn(), setSetting: vi.fn() }));
vi.mock('electron', () => ({}));

import { ZOOM_FACTORS, stepZoom } from './zoom';

describe('stepZoom', () => {
  it('steps through the factor list', () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1.1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(0.9, -1)).toBe(0.8);
  });

  it('stops at both ends', () => {
    expect(stepZoom(ZOOM_FACTORS[0], -1)).toBe(ZOOM_FACTORS[0]);
    const max = ZOOM_FACTORS[ZOOM_FACTORS.length - 1];
    expect(stepZoom(max, 1)).toBe(max);
  });

  it('snaps an off-list factor to the next step and resets to 100%', () => {
    expect(stepZoom(1.05, 1)).toBe(1.1);
    expect(stepZoom(1.05, -1)).toBe(1);
    expect(stepZoom(1.75, 0)).toBe(1);
  });
});
