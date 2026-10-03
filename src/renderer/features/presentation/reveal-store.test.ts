import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REVEAL_MS, isRevealed, revealKey, useReveal } from './reveal-store';

describe('reveal store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useReveal.getState().clear();
  });
  afterEach(() => {
    useReveal.getState().clear();
    vi.useRealTimers();
  });

  it('keys a cell by tab, result row and column', () => {
    expect(revealKey('t1', 4, 2)).toBe('t1:4:2');
  });

  it('reveals a cell and masks it again after the timeout', () => {
    const key = revealKey('t', 0, 1);
    useReveal.getState().reveal(key);
    expect(isRevealed(useReveal.getState().revealed, key)).toBe(true);
    vi.advanceTimersByTime(REVEAL_MS - 1);
    expect(isRevealed(useReveal.getState().revealed, key)).toBe(true);
    vi.advanceTimersByTime(2);
    expect(isRevealed(useReveal.getState().revealed, key)).toBe(false);
    expect(useReveal.getState().revealed).toEqual({});
  });

  it('restarts the timeout when a cell is revealed again', () => {
    const key = revealKey('t', 0, 1);
    useReveal.getState().reveal(key);
    vi.advanceTimersByTime(REVEAL_MS - 100);
    useReveal.getState().reveal(key);
    vi.advanceTimersByTime(REVEAL_MS - 100);
    expect(isRevealed(useReveal.getState().revealed, key)).toBe(true);
  });

  it('hides one cell or all of them on demand', () => {
    useReveal.getState().reveal('a');
    useReveal.getState().reveal('b');
    useReveal.getState().hide('a');
    expect(Object.keys(useReveal.getState().revealed)).toEqual(['b']);
    useReveal.getState().clear();
    expect(useReveal.getState().revealed).toEqual({});
  });
});
