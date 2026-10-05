/**
 * Which version a release should get, from what the update feed already
 * serves. Versioned files on the feed are immutable and every release gets a
 * git tag, so a version is usable only when:
 *   - it is above every version published for the platforms being released
 *     (so each platform's updater sees it as newer);
 *   - its git tag does not exist yet;
 *   - none of its installers for those platforms is in the bucket already
 *     (a failed run can leave orphans behind).
 * package.json wins when it is already above all of that (a manual bump).
 */

/** Platforms of the workflow's `platforms` input. */
export const PLATFORM_SETS = {
  all: ['win', 'mac', 'linux'],
  'windows+linux': ['win', 'linux'],
  windows: ['win'],
  mac: ['mac'],
  linux: ['linux'],
};

export const MANIFEST = { win: 'latest.yml', mac: 'latest-mac.yml', linux: 'latest-linux.yml' };

/** The installer that marks a version as published for a platform. */
export function installerName(os, version) {
  if (os === 'win') return `Plasma-Setup-${version}-x64.exe`;
  if (os === 'mac') return `Plasma-${version}-arm64.dmg`;
  return `Plasma-${version}-x86_64.AppImage`;
}

export function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim());
  if (!m) throw new Error(`not a release version: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export function bump(version, kind = 'patch') {
  const [maj, min, pat] = parseVersion(version);
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

/**
 * @param {object} p
 * @param {string} p.current package.json version
 * @param {string[]} p.published versions the feed serves for the chosen platforms
 * @param {'patch'|'minor'|'major'} [p.kind] step used when a bump is needed
 * @param {(v: string) => boolean} p.taken true when the version's tag or any of its installers exists
 * @returns {string}
 */
export function nextReleaseVersion({ current, published, kind = 'patch', taken }) {
  const highest = published.reduce(
    (max, v) => (max === null || compareVersions(v, max) > 0 ? v : max),
    null,
  );
  const top = highest === null || compareVersions(current, highest) > 0 ? current : highest;
  // patch: an unreleased package.json above everything published is used as
  // is. minor / major are explicit asks: always a step of that size.
  let candidate =
    kind === 'patch' ? (top === current && top !== highest ? current : bump(top, 'patch')) : bump(top, kind);
  // Already tagged or half-published: step past it (patch steps; the kind
  // only decides the first jump above what is published).
  for (let guard = 0; taken(candidate); guard++) {
    if (guard > 100) throw new Error('no free version found within 100 patch steps');
    candidate = bump(candidate, 'patch');
  }
  return candidate;
}
