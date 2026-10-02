/**
 * Site version sync, kept for release.mjs / sync-version.mjs / ship.mjs.
 *
 * The site no longer hard-codes download URLs: site/lib/feed.ts reads each
 * platform's manifest (latest.yml, latest-mac.yml, latest-linux.yml) from the
 * update feed at build time, so a Mac-only release can never rewrite the
 * Windows links. The only literal left in site/lib/version.ts is
 * PACKAGE_VERSION, the offline/dev label, and that is all this patches.
 */
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Patch site/lib/version.ts so PACKAGE_VERSION matches `version`.
 * @param {string} sitePath absolute path to site/lib/version.ts
 * @param {string} version semver string from package.json
 * @returns {{ changed: boolean }}
 */
export function syncSiteVersion(sitePath, version) {
  const before = readFileSync(sitePath, 'utf8');
  const after = before.replace(
    /(export const PACKAGE_VERSION\s*=\s*')([^']+)(')/,
    `$1${version}$3`,
  );

  if (before === after) {
    return { changed: false };
  }
  writeFileSync(sitePath, after);
  return { changed: true };
}
