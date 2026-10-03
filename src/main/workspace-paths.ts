import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

/**
 * Path confinement for workspaces. Every path that reaches the filesystem
 * for a workspace is built here from the (main-owned) root plus a relative
 * path that came from the renderer or from a file inside the repo, and is
 * refused unless it stays under that root — including through symlinks.
 */

export class PathConfinementError extends Error {
  constructor(message = 'Path is outside the workspace') {
    super(message);
    this.name = 'PathConfinementError';
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** realpath of the deepest ancestor of `p` that exists, re-joined with the missing tail. */
function realpathOfNearest(p: string): string {
  let existing = p;
  const tail: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    tail.unshift(parse(existing).base);
    existing = parent;
  }
  return join(realpathSync(existing), ...tail);
}

/**
 * Resolve `rel` under `root` or throw. `rel` must be a plain relative path:
 * no NUL bytes, not absolute, no drive letter, no `..` escape. Symlinks that
 * lead out of the root are refused too.
 */
export function confineToRoot(root: string, rel: string): string {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 1024) {
    throw new PathConfinementError('Invalid path');
  }
  if (rel.includes('\0')) throw new PathConfinementError('Invalid path');
  if (isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.startsWith('\\') || rel.startsWith('//')) {
    throw new PathConfinementError('Absolute paths are not allowed');
  }
  const base = resolve(root);
  const target = resolve(base, rel);
  if (!isInside(base, target)) throw new PathConfinementError();
  // Symlink escape: compare real locations.
  const realBase = realpathOfNearest(base);
  if (!isInside(realBase, realpathOfNearest(target))) throw new PathConfinementError();
  return target;
}

const SEGMENT_BAD = /[\0<>:"|?*\\]/;

/** A query path as stored in the UI: posix, relative, `.sql`, no odd segments. */
export function assertQueryRelPath(rel: unknown): string {
  if (typeof rel !== 'string' || !rel.toLowerCase().endsWith('.sql') || rel.length > 300) {
    throw new PathConfinementError('Query files must end in .sql');
  }
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.' || seg === '..' || SEGMENT_BAD.test(seg)) {
      throw new PathConfinementError('Invalid query path');
    }
  }
  return rel;
}

/** A single file name (notebooks): no separators at all. */
export function assertFileName(name: unknown, suffix: string): string {
  if (
    typeof name !== 'string' ||
    !name.endsWith(suffix) ||
    name.length > 200 ||
    name === suffix ||
    name.startsWith('.') ||
    /[\\/]/.test(name) ||
    SEGMENT_BAD.test(name)
  ) {
    throw new PathConfinementError('Invalid file name');
  }
  return name;
}
