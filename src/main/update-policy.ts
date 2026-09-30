/** Pure update-policy helpers (no electron-updater import, so unit-testable). */

/**
 * C20 — update integrity. The feed is a public bucket and `latest.yml`
 * carries the installer's sha512, so the hash alone proves nothing about
 * who published the update. Real protection needs code signing:
 * - Windows: when the build is signed and `publisherName` is set
 *   (electron-builder writes it into app-update.yml), electron-updater
 *   verifies the installer's Authenticode signature against it.
 * - macOS: Squirrel.Mac only accepts updates signed like the running app
 *   (needs a Developer ID + notarization; see electron-builder.yml).
 * Without a verifiable signature Plasma still downloads in the background
 * but never installs silently on quit — only on an explicit
 * "Restart & install". Downgrades and prereleases are always refused.
 */
export type UpdatePolicy = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  signatureVerified: boolean;
};

export function updatePolicy(platform: string, publisherName: string | null): UpdatePolicy {
  const signatureVerified = platform === 'win32' && Boolean(publisherName);
  return { autoDownload: true, autoInstallOnAppQuit: signatureVerified, signatureVerified };
}

/** `publisherName` from the packaged app-update.yml, or null when absent. */
export function readPublisherName(yaml: string): string | null {
  const inline = /^publisherName:[ \t]*(\S.*)$/m.exec(yaml);
  if (inline?.[1]) {
    const value = inline[1].trim();
    if (value.startsWith('[')) {
      const first = /["']?([^"'\],]+)["']?/.exec(value.slice(1));
      return first?.[1]?.trim() || null;
    }
    return value.replace(/^["']|["']$/g, '') || null;
  }
  const list = /^publisherName:\s*\n\s*-\s*(.+)$/m.exec(yaml);
  return list?.[1]?.trim().replace(/^["']|["']$/g, '') || null;
}

/** A window, or a getter for whichever window is current (C33). */
export type WindowRef<W> = W | null | (() => W | null);

/** Normalise a `WindowRef` into a getter that is read on every use. */
export function resolveWindow<W>(ref: WindowRef<W>): () => W | null {
  return typeof ref === 'function' ? (ref as () => W | null) : () => ref;
}
