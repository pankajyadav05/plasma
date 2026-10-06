import { describe, expect, it } from 'vitest';
import {
  SMALL_PNG_BYTES,
  dataUrlBytes,
  fitWithin,
  formatImageSize,
  isAcceptedImageType,
  pickFormat,
} from './ai-images';

describe('fitWithin', () => {
  it('never upscales or touches an image already within the edge', () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600, scaled: false });
    expect(fitWithin(1568, 1000)).toEqual({ width: 1568, height: 1000, scaled: false });
  });

  it('scales the long edge to 1568 and keeps the ratio', () => {
    expect(fitWithin(3136, 1568)).toEqual({ width: 1568, height: 784, scaled: true });
    expect(fitWithin(1000, 4000)).toEqual({ width: 392, height: 1568, scaled: true });
  });

  it('never produces a zero side', () => {
    expect(fitWithin(100000, 10).height).toBe(1);
  });

  it('honours another max edge', () => {
    expect(fitWithin(2000, 1000, 500)).toEqual({ width: 500, height: 250, scaled: true });
  });
});

describe('pickFormat', () => {
  const base = { mime: 'image/png', bytes: 50_000, scaled: false, hasAlpha: false };
  it('keeps a small untouched PNG', () => {
    expect(pickFormat(base)).toBe('png');
  });
  it('keeps PNG for transparency, whatever the size', () => {
    expect(pickFormat({ ...base, hasAlpha: true, bytes: 9_000_000, scaled: true })).toBe('png');
  });
  it('uses JPEG for large, downscaled and photographic images', () => {
    expect(pickFormat({ ...base, bytes: SMALL_PNG_BYTES + 1 })).toBe('jpeg');
    expect(pickFormat({ ...base, scaled: true })).toBe('jpeg');
    expect(pickFormat({ ...base, mime: 'image/jpeg' })).toBe('jpeg');
    expect(pickFormat({ ...base, mime: 'image/webp' })).toBe('jpeg');
  });
});

describe('helpers', () => {
  it('counts the bytes behind a data URL', () => {
    expect(dataUrlBytes('data:image/png;base64,AAAA')).toBe(3);
    expect(dataUrlBytes('data:image/png;base64,AAA=')).toBe(2);
    expect(dataUrlBytes('data:image/png;base64,AA==')).toBe(1);
  });
  it('formats sizes', () => {
    expect(formatImageSize(900)).toBe('900 B');
    expect(formatImageSize(2048)).toBe('2 KB');
    expect(formatImageSize(3.5 * 1024 * 1024)).toBe('3.5 MB');
  });
  it('accepts only the four types', () => {
    expect(isAcceptedImageType('image/png')).toBe(true);
    expect(isAcceptedImageType('image/svg+xml')).toBe(false);
    expect(isAcceptedImageType('image/heic')).toBe(false);
  });
});
