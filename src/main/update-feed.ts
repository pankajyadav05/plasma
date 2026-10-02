/**
 * Helpers for the manual-download path the macOS updater falls back to when
 * the installed build has no certificate-backed signature (see
 * `mac-signature.ts`). Pure string work so it can be unit tested without
 * Electron.
 */

/** Where users always find current builds when no feed URL is available. */
export const SITE_DOWNLOAD_URL = 'https://plasma.sh';

/**
 * Pulls the feed base out of the packaged `app-update.yml`.
 *
 * electron-builder writes that file into `Contents/Resources` from the
 * `publish` block in `electron-builder.yml`, so it is the only place inside a
 * build that knows which URL space the build was published to — the same
 * bucket that serves the .dmg the user has to install by hand.
 */
export function parseFeedBaseUrl(appUpdateYml: string): string | null {
  const match = /^url:[ \t]*(?:"([^"]+)"|'([^']+)'|(\S+))[ \t]*$/m.exec(appUpdateYml);
  const raw = match?.[1] ?? match?.[2] ?? match?.[3];
  if (raw == null || !/^https?:\/\//.test(raw)) return null;
  return raw.replace(/\/+$/, '');
}

/**
 * Direct .dmg URL for a macOS release, mirroring
 * `artifactName: ${productName}-${version}-${arch}.${ext}` in
 * `electron-builder.yml`. Falls back to the download page whenever the feed
 * URL or the platform is anything unexpected, so the button never points at a
 * URL that was guessed from nothing.
 */
export function macDownloadUrl(feedBaseUrl: string | null, version: string, arch: string): string {
  if (feedBaseUrl == null) return SITE_DOWNLOAD_URL;
  if (arch !== 'arm64' && arch !== 'x64') return SITE_DOWNLOAD_URL;
  if (!/^\d+\.\d+\.\d+/.test(version)) return SITE_DOWNLOAD_URL;
  return `${feedBaseUrl}/Plasma-${version}-${arch}.dmg`;
}
