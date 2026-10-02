'use client';

import { useEffect, useState } from 'react';
import type { DownloadVariant, Os, Releases } from './feed';
import { useReleases } from './releases-context';

/** What the visitor is on. `mobile` covers phones and tablets (no desktop build exists). */
export type Visitor = 'win' | 'mac' | 'linux' | 'mobile' | 'unknown';

interface NavigatorWithUAData extends Navigator {
  userAgentData?: { platform?: string; mobile?: boolean };
}

/** Pure detector, exported for tests. iPadOS reports a Mac platform but has touch points. */
export function detectVisitor(nav: {
  platform?: string;
  userAgent?: string;
  maxTouchPoints?: number;
  userAgentData?: { platform?: string; mobile?: boolean };
}): Visitor {
  const ua = nav.userAgent ?? '';
  const uaPlatform = nav.userAgentData?.platform ?? '';
  if (nav.userAgentData?.mobile || /Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return 'mobile';
  const isMac = uaPlatform === 'macOS' || /^Mac/i.test(nav.platform ?? '') || /\bMac OS X\b/.test(ua);
  // iPadOS 13+ masquerades as a Mac but is a touch device.
  if (isMac && (nav.maxTouchPoints ?? 0) > 1) return 'mobile';
  if (isMac) return 'mac';
  if (uaPlatform === 'Windows' || /^Win/i.test(nav.platform ?? '') || /Windows/.test(ua)) return 'win';
  if (uaPlatform === 'Linux' || /Linux|X11|CrOS/.test(`${nav.platform ?? ''} ${ua}`)) return 'linux';
  return 'unknown';
}

export interface PlatformState {
  /** Detected visitor; `unknown` until mounted (SSR and no-JS render the neutral state). */
  visitor: Visitor;
  /** `mac` when the visitor is on macOS, otherwise `win`: only used to pick keycap glyphs. */
  os: 'mac' | 'win';
  /** The visitor's own build, or null (unknown visitor, mobile, or no build for that OS yet). */
  primary: DownloadVariant | null;
  /** Every other downloadable variant, across platforms. */
  alternates: DownloadVariant[];
  releases: Releases;
}

const ORDER: Os[] = ['mac', 'win', 'linux'];

export function pickPrimary(visitor: Visitor, releases: Releases): DownloadVariant | null {
  if (visitor === 'unknown' || visitor === 'mobile') return null;
  return releases[visitor]?.variants[0] ?? null;
}

export function usePlatform(): PlatformState {
  const releases = useReleases();
  const [visitor, setVisitor] = useState<Visitor>('unknown');

  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    setVisitor(detectVisitor(navigator as NavigatorWithUAData));
  }, []);

  const primary = pickPrimary(visitor, releases);
  const all = ORDER.flatMap((os) => releases[os]?.variants ?? []);
  return {
    visitor,
    os: visitor === 'mac' ? 'mac' : 'win',
    primary,
    alternates: all.filter((v) => v !== primary),
    releases,
  };
}
