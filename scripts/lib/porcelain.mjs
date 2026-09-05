/**
 * Parse `git status --porcelain -z` output without corrupting leading status columns.
 * Porcelain XY codes use a leading space for unstaged-only changes (e.g. " M path");
 * trimming before slicing turns that into path "ackage.json".
 */

/** Paths ship.mjs may leave dirty; release rewrites/stages them and ship commits them wholesale. */
export const SHIP_ALLOWED_PATHS = new Set(['package.json', 'site/lib/version.ts']);

/**
 * @param {string} stdout raw stdout from `git status --porcelain -z`
 * @returns {{ xy: string, path: string, newPath?: string }[]}
 */
export function parsePorcelainZ(stdout) {
  const entries = [];
  // Trailing NUL yields an empty final part — drop empties.
  const parts = stdout.split('\0').filter((p) => p.length > 0);
  let i = 0;
  while (i < parts.length) {
    const header = parts[i];
    const xy = header.slice(0, 2);
    const path = header.slice(3);
    /** @type {{ xy: string, path: string, newPath?: string }} */
    const entry = { xy, path };
    // Rename/copy: XY ORIG_PATH\0NEW_PATH\0
    if (xy[0] === 'R' || xy[0] === 'C') {
      i += 1;
      if (i >= parts.length) {
        throw new Error(`porcelain -z: rename/copy missing new path after ${JSON.stringify(header)}`);
      }
      entry.newPath = parts[i];
    }
    entries.push(entry);
    i += 1;
  }
  return entries;
}

/**
 * @param {{ xy: string, path: string, newPath?: string }} entry
 * @param {Set<string>} allowed
 */
export function isAllowedPorcelainEntry(entry, allowed = SHIP_ALLOWED_PATHS) {
  if (!allowed.has(entry.path)) return false;
  if (entry.newPath !== undefined && !allowed.has(entry.newPath)) return false;
  return true;
}
