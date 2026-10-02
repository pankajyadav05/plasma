import { describe, expect, it } from 'vitest';
import { compareVersions, loadReleasesFrom, parseManifest, variantsFor } from './feed';

const BASE = 'https://pub-05a2064511bc41689f299b542b07b67f.r2.dev';

const WIN = `version: 0.0.20
files:
  - url: Plasma-Setup-0.0.20-x64.exe
    sha512: abc
    size: 96253637
path: Plasma-Setup-0.0.20-x64.exe
`;
const MAC = `version: 3.0.0
files:
  - url: Plasma-3.0.0-x64.zip
    sha512: a
    size: 161719738
  - url: Plasma-3.0.0-arm64.dmg
    sha512: b
    size: 163236620
  - url: Plasma-3.0.0-x64.dmg
    sha512: c
    size: 166919791
path: Plasma-3.0.0-x64.zip
`;

/** A fake feed: `files` maps path to body (manifests) or null (exists, empty). */
function feed(files: Record<string, string | null>, headMissing: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const name = decodeURIComponent(url.pathname.slice(1));
    const method = init?.method ?? 'GET';
    const missing = headMissing.includes(name) || !(name in files);
    if (missing) return new Response('nope', { status: 404 });
    return new Response(method === 'HEAD' ? null : (files[name] ?? ''), {
      status: 200,
      headers: { 'content-length': '10' },
    });
  }) as typeof fetch;
}

describe('parseManifest', () => {
  it('reads version, files and sizes', () => {
    expect(parseManifest(MAC).version).toBe('3.0.0');
    expect(parseManifest(MAC).files.map((f) => f.url)).toContain('Plasma-3.0.0-arm64.dmg');
  });

  it('rejects unsafe versions and file names (they become URLs)', () => {
    expect(() => parseManifest('version: 1.2.3/../x\nfiles:\n  - url: a.dmg\n')).toThrow(
      /unsafe version/,
    );
    expect(() => parseManifest('version: 1.2.3\nfiles:\n  - url: ../evil.dmg\n')).toThrow(
      /unsafe file/,
    );
    expect(() => parseManifest('version: 1.2.3\nfiles:\n')).toThrow(/no files/);
  });
});

describe('variantsFor', () => {
  it('offers only dmg files for macOS, Apple Silicon first, never the updater zip', () => {
    const v = variantsFor('mac', parseManifest(MAC));
    expect(v.map((x) => x.key)).toEqual(['mac-arm64', 'mac-x64']);
    expect(v[0]?.url).toBe(`${BASE}/Plasma-3.0.0-arm64.dmg`);
    expect(v[0]?.sizeLabel).toBe('156 MB');
  });
});

describe('compareVersions', () => {
  it('orders numerically', () => {
    expect(compareVersions('0.0.20', '3.0.0')).toBe(-1);
    expect(compareVersions('3.10.0', '3.9.0')).toBe(1);
  });
});

describe('loadReleasesFrom', () => {
  it('derives each platform from its own manifest and leaves missing platforms empty', async () => {
    const releases = await loadReleasesFrom(
      feed({
        'latest.yml': WIN,
        'latest-mac.yml': MAC,
        'Plasma-Setup-0.0.20-x64.exe': null,
        'Plasma-3.0.0-arm64.dmg': null,
        'Plasma-3.0.0-x64.dmg': null,
      }),
    );
    expect(releases.win?.version).toBe('0.0.20');
    expect(releases.mac?.version).toBe('3.0.0');
    expect(releases.linux).toBeNull();
    expect(releases.latestVersion).toBe('3.0.0');
    // The Windows link is the 0.0.20 installer, untouched by the 3.0.0 Mac release.
    expect(releases.win?.variants[0]?.url).toBe(`${BASE}/Plasma-Setup-0.0.20-x64.exe`);
    // No portable build exists for 0.0.20, so none is offered.
    expect(releases.win?.variants.map((v) => v.key)).toEqual(['win-installer']);
  });

  it('fails the build when a referenced file is missing', async () => {
    await expect(
      loadReleasesFrom(
        feed({
          'latest-mac.yml': MAC,
          'Plasma-3.0.0-arm64.dmg': null,
          // the x64 dmg is referenced but absent
        }),
      ),
    ).rejects.toThrow(/dead download links[\s\S]*Plasma-3\.0\.0-x64\.dmg/);
  });

  it('fails loudly on a feed error that is not "no build yet"', async () => {
    const broken = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    await expect(loadReleasesFrom(broken)).rejects.toThrow(/HTTP 500/);
  });

  it('shows every platform as unavailable when the feed has no manifests', async () => {
    const releases = await loadReleasesFrom(feed({}));
    expect(releases).toEqual({ win: null, mac: null, linux: null, latestVersion: null });
  });
});
