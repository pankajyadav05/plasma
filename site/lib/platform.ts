'use client';

import { useEffect, useState } from 'react';
import {
  DOWNLOAD_URL,
  MAC_ARM64_SIZE_LABEL,
  MAC_ARM64_URL,
  MAC_X64_SIZE_LABEL,
  MAC_X64_URL,
  PORTABLE_URL,
  SIZE_LABEL,
} from './version';

export type Os = 'win' | 'mac';

export interface DownloadVariant {
  key: 'win-installer' | 'win-portable' | 'mac-arm64' | 'mac-x64';
  label: string;
  cursor: string;
  url: string;
  sizeLabel: string;
  /** filename portion of the URL — used for terminal-mock display */
  basename: string;
}

function basenameOf(url: string): string {
  return url.slice(url.lastIndexOf('/') + 1);
}

const WIN_INSTALLER: DownloadVariant = {
  key: 'win-installer',
  label: 'Windows installer',
  cursor: `win·x64 · ${SIZE_LABEL}`,
  url: DOWNLOAD_URL,
  sizeLabel: SIZE_LABEL,
  basename: basenameOf(DOWNLOAD_URL),
};

const WIN_PORTABLE: DownloadVariant = {
  key: 'win-portable',
  label: 'Portable EXE',
  cursor: `win·x64 portable · ${SIZE_LABEL}`,
  url: PORTABLE_URL,
  sizeLabel: SIZE_LABEL,
  basename: basenameOf(PORTABLE_URL),
};

const MAC_ARM64: DownloadVariant = {
  key: 'mac-arm64',
  label: 'macOS · Apple Silicon',
  cursor: `mac·arm64 · ${MAC_ARM64_SIZE_LABEL}`,
  url: MAC_ARM64_URL,
  sizeLabel: MAC_ARM64_SIZE_LABEL,
  basename: basenameOf(MAC_ARM64_URL),
};

const MAC_X64: DownloadVariant = {
  key: 'mac-x64',
  label: 'Intel Mac',
  cursor: `mac·x64 · ${MAC_X64_SIZE_LABEL}`,
  url: MAC_X64_URL,
  sizeLabel: MAC_X64_SIZE_LABEL,
  basename: basenameOf(MAC_X64_URL),
};

interface PlatformState {
  os: Os;
  primary: DownloadVariant;
  alternates: DownloadVariant[];
}

const WIN_DEFAULT: PlatformState = {
  os: 'win',
  primary: WIN_INSTALLER,
  alternates: [MAC_ARM64, MAC_X64, WIN_PORTABLE],
};

const MAC_DEFAULT: PlatformState = {
  os: 'mac',
  primary: MAC_ARM64,
  alternates: [MAC_X64, WIN_INSTALLER, WIN_PORTABLE],
};

/**
 * SSR-safe platform detection. Server and first paint return the Windows
 * default (matches what the static HTML used to ship — no hydration
 * mismatch). After mount, sniff the visitor and re-render with the right
 * primary CTA + alternates list.
 *
 * Apple Silicon is the default on macOS (overwhelming share since 2020);
 * Intel users land on it via the `Intel Mac` sub-link.
 */
export function usePlatform(): PlatformState {
  const [state, setState] = useState<PlatformState>(WIN_DEFAULT);

  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    const uaPlatform =
      (navigator as Navigator & { userAgentData?: { platform?: string } })
        .userAgentData?.platform ?? '';
    const isMac =
      uaPlatform === 'macOS' ||
      /^Mac/i.test(navigator.platform) ||
      /\bMac OS X\b/.test(navigator.userAgent);
    setState(isMac ? MAC_DEFAULT : WIN_DEFAULT);
  }, []);

  return state;
}
