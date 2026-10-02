import { describe, expect, it } from 'vitest';
import {
  SITE_DOWNLOAD_URL,
  macDownloadUrl,
  macDownloadUrlFromManifest,
  parseFeedBaseUrl,
} from './update-feed';

/**
 * When macOS auto-install is impossible (unsigned build — see
 * mac-signature.ts) the About panel offers a direct .dmg download instead.
 * That URL is derived from the manifest electron-builder bakes into the
 * bundle, so it always points at the bucket the running build was published
 * to, and its shape must match the published artifact names:
 * `Plasma-<version>-<arch>.dmg`.
 */

const GENERIC_MANIFEST = `provider: generic
url: https://pub-05a2064511bc41689f299b542b07b67f.r2.dev
channel: latest
useMultipleRangeRequest: false
updaterCacheDirName: plasma-updater
`;

describe('parseFeedBaseUrl', () => {
  it('reads the generic provider URL out of app-update.yml', () => {
    expect(parseFeedBaseUrl(GENERIC_MANIFEST)).toBe(
      'https://pub-05a2064511bc41689f299b542b07b67f.r2.dev',
    );
  });

  it('strips a trailing slash so joined paths never double up', () => {
    expect(parseFeedBaseUrl('provider: generic\nurl: "https://cdn.example.com/plasma/"\n')).toBe(
      'https://cdn.example.com/plasma',
    );
  });

  it('rejects a manifest with no absolute URL', () => {
    // GitHub/S3 providers describe the feed with owner/repo or bucket keys.
    expect(parseFeedBaseUrl('provider: github\nowner: pankajyadav05\nrepo: plasma\n')).toBeNull();
    expect(parseFeedBaseUrl('provider: generic\nurl: plasma/latest\n')).toBeNull();
  });
});

describe('macDownloadUrl', () => {
  it('builds the published .dmg URL for the running architecture', () => {
    const base = parseFeedBaseUrl(GENERIC_MANIFEST);
    expect(macDownloadUrl(base, '0.0.20', 'arm64')).toBe(
      'https://pub-05a2064511bc41689f299b542b07b67f.r2.dev/Plasma-0.0.20-arm64.dmg',
    );
    expect(macDownloadUrl(base, '0.0.20', 'x64')).toBe(
      'https://pub-05a2064511bc41689f299b542b07b67f.r2.dev/Plasma-0.0.20-x64.dmg',
    );
  });

  it('falls back to the download page instead of guessing a URL', () => {
    expect(macDownloadUrl(null, '0.0.20', 'arm64')).toBe(SITE_DOWNLOAD_URL);
    expect(macDownloadUrl('https://cdn.example.com', '0.0.20', 'universal')).toBe(
      SITE_DOWNLOAD_URL,
    );
    expect(macDownloadUrl('https://cdn.example.com', 'nightly', 'arm64')).toBe(SITE_DOWNLOAD_URL);
  });
});

describe('SC-24: version must be a whole, safe version string', () => {
  it.each(['1.2.3/../x', '1.2.3?evil', '1.2.3#frag', '1.2.3 ', '1.2', '../1.2.3', '1.2.3/'])(
    'falls back to the download page for %j',
    (version) => {
      expect(macDownloadUrl('https://cdn.example.com', version, 'arm64')).toBe(SITE_DOWNLOAD_URL);
    },
  );

  it('still accepts release and pre-release versions', () => {
    expect(macDownloadUrl('https://cdn.example.com', '1.2.3-beta.1', 'x64')).toBe(
      'https://cdn.example.com/Plasma-1.2.3-beta.1-x64.dmg',
    );
  });
});

describe('macDownloadUrlFromManifest', () => {
  const files = [{ url: 'Plasma-3.1.0-arm64.zip' }, { url: 'Plasma-3.1.0-arm64.dmg' }];
  it('uses the dmg listed in the signed manifest', () => {
    expect(macDownloadUrlFromManifest('https://cdn.example.com', files, '3.1.0', 'arm64')).toBe(
      'https://cdn.example.com/Plasma-3.1.0-arm64.dmg',
    );
  });

  it('falls back to the derived URL when the manifest lists no dmg for the arch', () => {
    expect(macDownloadUrlFromManifest('https://cdn.example.com', files, '3.1.0', 'x64')).toBe(
      'https://cdn.example.com/Plasma-3.1.0-x64.dmg',
    );
  });
});
