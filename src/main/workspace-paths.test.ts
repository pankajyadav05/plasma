import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PathConfinementError,
  assertFileName,
  assertQueryRelPath,
  confineToRoot,
} from './workspace-paths';

let root: string;
let outside: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'plasma-ws-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'plasma-out-')));
  mkdirSync(join(root, '.plasma', 'queries'), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('confineToRoot', () => {
  it('resolves plain relative paths, existing or not', () => {
    expect(confineToRoot(root, '.plasma/queries/a.sql')).toBe(join(root, '.plasma/queries/a.sql'));
    expect(confineToRoot(root, 'new/dir/file.sql')).toBe(join(root, 'new/dir/file.sql'));
  });

  it.each(['../x', '../../etc/passwd', 'a/../../x', '..', 'a/b/../../../x'])('refuses %s', (p) => {
    expect(() => confineToRoot(root, p)).toThrow(PathConfinementError);
  });

  it.each(['/etc/passwd', 'C:\\Windows', 'c:/x', '\\\\server\\share', '//host/x', ''])(
    'refuses %j',
    (p) => {
      expect(() => confineToRoot(root, p)).toThrow(PathConfinementError);
    },
  );

  it('refuses NUL bytes', () => {
    expect(() => confineToRoot(root, 'a\0b')).toThrow(PathConfinementError);
  });

  it('allows .. that stays inside', () => {
    expect(confineToRoot(root, 'a/../b.sql')).toBe(join(root, 'b.sql'));
  });

  it('refuses a symlinked directory that leads out of the root', () => {
    symlinkSync(outside, join(root, '.plasma', 'queries', 'evil'));
    expect(() => confineToRoot(root, '.plasma/queries/evil/x.sql')).toThrow(PathConfinementError);
  });

  it('refuses a symlinked file that leads out of the root', () => {
    writeFileSync(join(outside, 'secret'), 'x');
    symlinkSync(join(outside, 'secret'), join(root, 'link.sql'));
    expect(() => confineToRoot(root, 'link.sql')).toThrow(PathConfinementError);
  });

  it('refuses a sibling whose name merely starts with the root name', () => {
    expect(() => confineToRoot(root, `../${root.split('/').pop()}-evil/x`)).toThrow(
      PathConfinementError,
    );
  });
});

describe('assertQueryRelPath', () => {
  it('accepts nested .sql paths', () => {
    expect(assertQueryRelPath('reports/q1/top.sql')).toBe('reports/q1/top.sql');
  });
  it.each([
    'a.txt',
    '../a.sql',
    'a//b.sql',
    './a.sql',
    'a\\b.sql',
    '/a.sql',
    'a/./b.sql',
    'a:b.sql',
    5,
    null,
  ])('refuses %j', (p) => {
    expect(() => assertQueryRelPath(p)).toThrow(PathConfinementError);
  });
});

describe('assertFileName', () => {
  const S = '.plasma-notebook.json';
  it('accepts a plain name', () => {
    expect(assertFileName(`a${S}`, S)).toBe(`a${S}`);
  });
  it.each([`../a${S}`, `a/b${S}`, `.hidden${S}`, S, 'a.json', 3])('refuses %j', (n) => {
    expect(() => assertFileName(n, S)).toThrow(PathConfinementError);
  });
});
