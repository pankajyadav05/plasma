import { describe, expect, it } from 'vitest';
import { FOCUS_OWNER_SELECTOR, shouldRefocusGrid } from './grid-focus';

describe('shouldRefocusGrid (R-05)', () => {
  it('refocuses when nothing owns focus or the grid itself does', () => {
    expect(shouldRefocusGrid(null)).toBe(true);
    expect(shouldRefocusGrid({ closest: () => null })).toBe(true);
  });

  it('leaves focus alone when an input, editor or dialog has it', () => {
    expect(
      shouldRefocusGrid({ closest: (sel) => (sel === FOCUS_OWNER_SELECTOR ? {} : null) }),
    ).toBe(false);
  });

  it('covers inputs, textareas and dialogs in the selector', () => {
    for (const part of ['input', 'textarea', '[role="dialog"]']) {
      expect(FOCUS_OWNER_SELECTOR).toContain(part);
    }
  });
});
