/**
 * Pure feed logic (no Next/server-only imports, unit-tested from the root
 * vitest run): download links, versions and sizes come from the update feed
 * itself, at build time. The feed (latest.yml / latest-mac.yml / latest-linux.yml on the
 * R2 bucket) is what the apps update from, so it is the one source of truth:
 *
 *  - every platform has its OWN version (a Mac-only release must not rewrite
 *    the Windows links);
 *  - a file the manifest references must exist, or the build FAILS loudly
 *    instead of publishing a dead link;
 *  - a platform whose manifest does not exist yet is "coming soon", never a link.
 */

export const LICENSE = 'Apache-2.0';
export const FEED_BASE = (
  process.env.PLASMA_FEED_URL ?? 'https://pub-05a2064511bc41689f299b542b07b67f.r2.dev'
).replace(/\/+$/, '');
export const RELEASES_PAGE = 'https://github.com/pankajyadav05/plasma/releases/latest';

export type Os = 'win' | 'mac' | 'linux';

export interface DownloadVariant {
  key: string;
  os: Os;
  label: string;
  /** Terminal-mock style one-liner, e.g. `mac·arm64 · 156 MB`. */
  cursor: string;
  url: string;
  sizeLabel: string;
  /** Filename portion of the URL, for the terminal mock. */
  basename: string;
  version: string;
}

export interface PlatformRelease {
  os: Os;
  version: string;
  variants: DownloadVariant[];
}

export interface Releases {
  win: PlatformRelease | null;
  mac: PlatformRelease | null;
  linux: PlatformRelease | null;
  /** Highest version across the platforms that have a build, or null. */
  latestVersion: string | null;
}

export interface ManifestFile {
  url: string;
  size?: number;
}
export interface Manifest {
  version: string;
  files: ManifestFile[];
}

const SAFE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The `version:` and `files:` list of an electron-builder manifest. */
export function parseManifest(text: string, name = 'manifest'): Manifest {
  const version = /^version:[ \t]*['"]?([^'"\s]+)['"]?[ \t]*$/m.exec(text)?.[1];
  if (!version || !SAFE_VERSION.test(version)) {
    throw new Error(`${name}: missing or unsafe version (${JSON.stringify(version)})`);
  }
  const files: ManifestFile[] = [];
  let current: ManifestFile | null = null;
  let inFiles = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^files:\s*$/.test(line)) {
      inFiles = true;
      continue;
    }
    if (inFiles && /^\S/.test(line)) inFiles = false;
    if (!inFiles) continue;
    const item = /^\s*-\s+url:[ \t]*(\S+)\s*$/.exec(line);
    if (item?.[1]) {
      const url = item[1].replace(/^["']|["']$/g, '');
      if (!SAFE_FILE.test(url)) throw new Error(`${name}: unsafe file name ${JSON.stringify(url)}`);
      current = { url };
      files.push(current);
      continue;
    }
    const size = /^\s+size:[ \t]*(\d+)\s*$/.exec(line);
    if (size?.[1] && current) current.size = Number(size[1]);
  }
  if (files.length === 0) throw new Error(`${name}: lists no files`);
  return { version, files };
}

export function sizeLabel(bytes: number | undefined): string {
  return bytes ? `${Math.round(bytes / 1024 / 1024)} MB` : '';
}

const fileUrl = (name: string) => `${FEED_BASE}/${encodeURIComponent(name)}`;

function variant(
  os: Os,
  key: string,
  label: string,
  tag: string,
  file: ManifestFile,
  version: string,
): DownloadVariant {
  const size = sizeLabel(file.size);
  return {
    key,
    os,
    label,
    cursor: size ? `${tag} · ${size}` : tag,
    url: fileUrl(file.url),
    sizeLabel: size,
    basename: file.url,
    version,
  };
}

/** Pure: turns one platform's manifest into the download cards it supports. */
export function variantsFor(os: Os, m: Manifest): DownloadVariant[] {
  const out: DownloadVariant[] = [];
  for (const f of m.files) {
    const n = f.url;
    if (os === 'win' && n.endsWith('.exe')) {
      const portable = /portable/i.test(n);
      out.push(
        variant(
          'win',
          portable ? 'win-portable' : 'win-installer',
          portable ? 'Portable EXE' : 'Windows installer',
          portable ? 'win·x64 portable' : 'win·x64',
          f,
          m.version,
        ),
      );
    } else if (os === 'mac' && n.endsWith('.dmg')) {
      const arm = /arm64/.test(n);
      out.push(
        variant(
          'mac',
          arm ? 'mac-arm64' : 'mac-x64',
          arm ? 'macOS · Apple Silicon' : 'Intel Mac',
          arm ? 'mac·arm64' : 'mac·x64',
          f,
          m.version,
        ),
      );
    } else if (os === 'linux' && n.endsWith('.AppImage')) {
      out.push(variant('linux', 'linux-appimage', 'Linux · AppImage', 'linux·x64', f, m.version));
    } else if (os === 'linux' && n.endsWith('.deb')) {
      out.push(variant('linux', 'linux-deb', 'Linux · .deb', 'linux·amd64 deb', f, m.version));
    }
  }
  // Apple Silicon first on macOS, installer before portable on Windows.
  const rank = (v: DownloadVariant) => (v.key === 'mac-arm64' || v.key === 'win-installer' ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b));
}

export function compareVersions(a: string, b: string): number {
  const nums = (v: string) => v.split('-')[0]!.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const x = nums(a);
  const y = nums(b);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

const MANIFESTS: Record<Os, string> = {
  win: 'latest.yml',
  mac: 'latest-mac.yml',
  linux: 'latest-linux.yml',
};

type Fetcher = typeof fetch;

/** Fetches a platform manifest. `null` = the platform has no build (404). */
async function fetchManifest(os: Os, doFetch: Fetcher): Promise<Manifest | null> {
  const name = MANIFESTS[os];
  const res = await doFetch(`${FEED_BASE}/${name}?cb=${Date.now()}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status} from the update feed`);
  return parseManifest(await res.text(), name);
}

/**
 * Builds the per-platform releases. Every file a manifest references is
 * HEAD-checked; a missing one throws (so `next build` fails) because it would
 * ship a dead download link.
 */
export async function loadReleasesFrom(doFetch: Fetcher): Promise<Releases> {
  const result: Releases = { win: null, mac: null, linux: null, latestVersion: null };
  const problems: string[] = [];

  for (const os of ['win', 'mac', 'linux'] as const) {
    const manifest = await fetchManifest(os, doFetch);
    if (!manifest) continue;
    const variants = variantsFor(os, manifest);
    if (variants.length === 0) {
      problems.push(`${MANIFESTS[os]} lists no downloadable ${os} installer`);
      continue;
    }
    // The Windows portable build is not part of latest.yml; offer it only if it exists.
    if (os === 'win' && !variants.some((v) => v.key === 'win-portable')) {
      const name = `Plasma-Portable-${manifest.version}-x64.exe`;
      const head = await doFetch(fileUrl(name), { method: 'HEAD' });
      if (head.ok) {
        const size = Number(head.headers.get('content-length')) || undefined;
        variants.push(
          variant('win', 'win-portable', 'Portable EXE', 'win·x64 portable', { url: name, size }, manifest.version),
        );
      }
    }
    for (const v of variants) {
      const head = await doFetch(v.url, { method: 'HEAD' });
      if (!head.ok) problems.push(`${MANIFESTS[os]} references ${v.basename}: HTTP ${head.status}`);
    }
    result[os] = { os, version: manifest.version, variants };
  }

  if (problems.length > 0) {
    throw new Error(
      `Refusing to build the site with dead download links:\n  - ${problems.join('\n  - ')}\n` +
        'Fix the release (pnpm release:verify) or re-upload the missing files, then rebuild.',
    );
  }

  const versions = [result.win, result.mac, result.linux].flatMap((p) => (p ? [p.version] : []));
  result.latestVersion = versions.sort(compareVersions).at(-1) ?? null;
  return result;
}

