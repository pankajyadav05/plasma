/** A tiny semantic-version comparer (no dependency): major.minor.patch, anything after is ignored. */

export type Semver = [number, number, number];

export function parseSemver(text: string | null | undefined): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec((text ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** <0, 0, >0; null when either side is not a version. */
export function compareSemver(a: string, b: string): number | null {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return null;
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}
