import 'server-only';
import { type Releases, loadReleasesFrom } from './feed';

export * from './feed';

/**
 * Download links, versions and sizes for the site, read from the update feed
 * at build time (see ./feed.ts for the rules: per-platform versions, HEAD
 * checks that fail the build, "coming soon" for platforms without a build).
 *
 * Set PLASMA_SITE_OFFLINE=1 to skip the network in `next dev` (every platform
 * then shows "coming soon"). Production builds never skip.
 */

/** package.json version at the last `release:*`; patched by scripts/lib/sync-site-version.mjs. Offline label only. */
export const PACKAGE_VERSION = '3.2.1';

let cached: Promise<Releases> | undefined;

/** Memoised per build; layout, footer and JSON-LD share one fetch. */
export function getReleases(): Promise<Releases> {
  cached ??= (async () => {
    if (process.env.PLASMA_SITE_OFFLINE === '1' && process.env.NODE_ENV !== 'production') {
      console.warn('[site] PLASMA_SITE_OFFLINE=1: no download links (all platforms "coming soon")');
      return { win: null, mac: null, linux: null, latestVersion: null };
    }
    return loadReleasesFrom(fetch);
  })();
  return cached;
}
