import { describe, expect, it } from 'vitest';
import {
  EDITOR_MAX_PX,
  EDITOR_MIN_PX,
  clampEditorHeight,
  isInteractiveTarget,
} from './EditorResizer';

describe('clampEditorHeight', () => {
  it('keeps the editor between the min and max heights', () => {
    expect(clampEditorHeight(10)).toBe(EDITOR_MIN_PX);
    expect(clampEditorHeight(5000)).toBe(EDITOR_MAX_PX);
    expect(clampEditorHeight(300.6)).toBe(301);
  });
});

describe('isInteractiveTarget', () => {
  const el = (insideControl: boolean) =>
    ({ closest: () => (insideControl ? {} : null) }) as unknown as Element;

  it('lets controls keep their clicks and drags everything else', () => {
    expect(isInteractiveTarget(el(true))).toBe(true);
    expect(isInteractiveTarget(el(false))).toBe(false);
    expect(isInteractiveTarget(null)).toBe(false);
  });
});
