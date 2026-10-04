/**
 * Update-manifest signing key (SC-01). See docs/release.md ("Signed update
 * manifests") for the whole scheme.
 *
 * `UPDATE_SIGNING_PUBLIC_KEY` is the raw 32-byte ed25519 public key, base64
 * encoded. Create the pair with `pnpm gen:update-key`: it prints this value
 * (paste it below) and writes the private half to `.env.local` only.
 *
 * While this is `null` no key is embedded and the updater behaves as before
 * (unsigned feed, logged warning). Paste the key BEFORE cutting the first
 * release that should enforce signatures.
 */
export const UPDATE_SIGNING_PUBLIC_KEY: string | null = "zNXVmyGe4ePrj4gdshfTnYYDs31atet/tGIzIbh2w+w=";

/**
 * Transition policy for feeds that were published before manifests were
 * signed. With a key embedded:
 *
 * - an update whose version is LOWER than this cut-off may be unsigned (a
 *   missing `<manifest>.sig` only logs a warning); a `.sig` that exists is
 *   always verified, and a bad one is always refused;
 * - an update whose version is this or higher MUST carry a valid signature,
 *   so stripping the `.sig` from a current release cannot downgrade the check.
 *
 * Set it to the first release that is published with signed manifests.
 */
export const SIGNED_UPDATES_REQUIRED_FROM = '3.1.0';
