import { describe, expect, it } from 'vitest';
import type { Releases } from './feed';
import { detectVisitor, pickPrimary } from './platform';

describe('detectVisitor', () => {
  it('detects desktop systems', () => {
    expect(
      detectVisitor({
        platform: 'MacIntel',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        maxTouchPoints: 0,
      }),
    ).toBe('mac');
    expect(
      detectVisitor({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }),
    ).toBe('win');
    expect(
      detectVisitor({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }),
    ).toBe('linux');
  });

  it('does not offer a .dmg to an iPad that reports a Mac platform', () => {
    expect(
      detectVisitor({
        platform: 'MacIntel',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        maxTouchPoints: 5,
      }),
    ).toBe('mobile');
  });

  it('treats phones and Android as mobile, not Linux', () => {
    expect(
      detectVisitor({
        platform: 'Linux armv8l',
        userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile',
      }),
    ).toBe('mobile');
    expect(
      detectVisitor({ platform: 'iPhone', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' }),
    ).toBe('mobile');
  });

  it('is unknown without any signal', () => {
    expect(detectVisitor({})).toBe('unknown');
  });
});

describe('pickPrimary', () => {
  const variant = (os: 'win' | 'mac' | 'linux') => ({
    key: `${os}-x`,
    os,
    label: os,
    cursor: os,
    url: `https://x/${os}`,
    sizeLabel: '',
    basename: os,
    version: '1.0.0',
  });
  const releases: Releases = {
    win: null,
    mac: { os: 'mac', version: '1.0.0', variants: [variant('mac')] },
    linux: null,
    latestVersion: '1.0.0',
  };

  it('returns the visitor’s own build only, never another platform’s', () => {
    expect(pickPrimary('mac', releases)?.url).toBe('https://x/mac');
    expect(pickPrimary('win', releases)).toBeNull();
    expect(pickPrimary('linux', releases)).toBeNull();
    expect(pickPrimary('unknown', releases)).toBeNull();
    expect(pickPrimary('mobile', releases)).toBeNull();
  });
});
