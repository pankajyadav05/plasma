/**
 * Single implementation for website version / download-asset URL sync.
 * Used by release.mjs (after bump) and sync-version.mjs (standalone).
 * Ship/release orchestration stays in those scripts.
 */
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Patch site/lib/version.ts so VERSION and artifact filenames match `version`.
 * @param {string} sitePath absolute path to site/lib/version.ts
 * @param {string} version semver string from package.json
 * @returns {{ changed: boolean }}
 */
export function syncSiteVersion(sitePath, version) {
  const before = readFileSync(sitePath, 'utf8');
  const after = before
    .replace(/(export const VERSION\s*=\s*')([^']+)(')/, `$1${version}$3`)
    .replace(/Plasma-Setup-\d+\.\d+\.\d+-x64\.exe/g, `Plasma-Setup-${version}-x64.exe`)
    .replace(/Plasma-Portable-\d+\.\d+\.\d+-x64\.exe/g, `Plasma-Portable-${version}-x64.exe`)
    // macOS DMGs
    .replace(/Plasma-\d+\.\d+\.\d+-arm64\.dmg/g, `Plasma-${version}-arm64.dmg`)
    .replace(/Plasma-\d+\.\d+\.\d+-x64\.dmg/g, `Plasma-${version}-x64.dmg`);

  if (before === after) {
    return { changed: false };
  }
  writeFileSync(sitePath, after);
  return { changed: true };
}
