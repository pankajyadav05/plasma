import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  APPIMAGE_MARKER,
  dirOnPath,
  installLauncher,
  installTargets,
  repointAppImageWrappers,
  windowsInstructions,
} from './cli-install';

let dir: string;
let script: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plasma-cli-'));
  mkdirSync(join(dir, 'res', 'bin'), { recursive: true });
  script = join(dir, 'res', 'bin', 'plasma');
  writeFileSync(
    script,
    `#!/bin/sh\n# plasma — command-line companion for the Plasma desktop app.\n${APPIMAGE_MARKER}\necho hi\n`,
    { mode: 0o755 },
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('installLauncher', () => {
  it('symlinks the script into the target directory (created if missing)', () => {
    const target = join(dir, 'home', '.local', 'bin');
    const res = installLauncher({ script, dir: target, pathEnv: `/usr/bin:${target}` });
    expect(readlinkSync(join(target, 'plasma'))).toBe(script);
    expect(res).toMatchObject({ kind: 'symlink', onPath: true });
    expect(installLauncher({ script, dir: target, pathEnv: '/usr/bin' }).onPath).toBe(false);
  });

  it('replaces its own previous install but never an unrelated `plasma`', () => {
    const target = join(dir, 'bin');
    installLauncher({ script, dir: target });
    expect(() => installLauncher({ script, dir: target })).not.toThrow();
    const other = join(dir, 'other');
    mkdirSync(other);
    writeFileSync(join(other, 'plasma'), '#!/bin/sh\necho not ours\n');
    expect(() => installLauncher({ script, dir: other })).toThrow(/not the Plasma launcher/);
    expect(readFileSync(join(other, 'plasma'), 'utf8')).toContain('not ours');
  });

  it('copies a wrapper pointing at the AppImage (the mount disappears with the app)', () => {
    const target = join(dir, 'bin');
    const res = installLauncher({
      script,
      dir: target,
      appImage: '/home/me/My "App"/Plasma.AppImage',
    });
    expect(res.kind).toBe('wrapper');
    const text = readFileSync(join(target, 'plasma'), 'utf8');
    expect(text).toContain('PLASMA_APP="/home/me/My \\"App\\"/Plasma.AppImage"');
    expect(statSync(join(target, 'plasma')).mode & 0o111).not.toBe(0);
  });

  it('fails when the script is missing', () => {
    expect(() => installLauncher({ script: join(dir, 'nope'), dir })).toThrow(
      /not part of this build/,
    );
  });
});

describe('helpers', () => {
  it('offers a user dir first, then /usr/local/bin', () => {
    expect(installTargets('/home/me')).toEqual([
      { dir: '/home/me/.local/bin', system: false },
      { dir: '/usr/local/bin', system: true },
    ]);
  });
  it('detects PATH membership', () => {
    expect(dirOnPath('/a', '/b:/a:/c')).toBe(true);
    expect(dirOnPath('/a', undefined)).toBe(false);
  });
  it('gives Windows instructions naming the launcher folder', () => {
    expect(windowsInstructions('C:\\Program Files\\Plasma\\resources\\bin\\plasma.cmd')).toContain(
      'C:\\Program Files\\Plasma\\resources\\bin',
    );
  });
});

describe('repointAppImageWrappers (AppImage renamed by an update)', () => {
  const OLD = '/home/u/Apps/Plasma-3.2.0-x86_64.AppImage';
  const NEW = '/home/u/Apps/Plasma-3.2.2-x86_64.AppImage';

  it('rewrites our wrapper so the CLI still reaches the app', () => {
    const bin = join(dir, 'bin');
    installLauncher({ script, dir: bin, appImage: OLD });
    const changed = repointAppImageWrappers([bin, join(dir, 'missing')], OLD, NEW);
    expect(changed).toEqual([join(bin, 'plasma')]);
    const text = readFileSync(join(bin, 'plasma'), 'utf8');
    expect(text).toContain(`PLASMA_APP="${NEW}"`);
    expect(text).not.toContain(OLD);
    expect(statSync(join(bin, 'plasma')).mode & 0o111).not.toBe(0);
  });

  it('copes with a path that needs escaping', () => {
    const bin = join(dir, 'bin');
    const odd = '/home/u/My $Apps/Plasma "x".AppImage';
    installLauncher({ script, dir: bin, appImage: odd });
    repointAppImageWrappers([bin], odd, NEW);
    expect(readFileSync(join(bin, 'plasma'), 'utf8')).toContain(`PLASMA_APP="${NEW}"`);
  });

  it('leaves symlink installs, other apps and wrappers for another AppImage alone', () => {
    const linked = join(dir, 'linked');
    installLauncher({ script, dir: linked });
    const other = join(dir, 'other');
    mkdirSync(other);
    writeFileSync(join(other, 'plasma'), `#!/bin/sh\n# someone else's\nPLASMA_APP="${OLD}"\n`);
    const unrelated = join(dir, 'unrelated');
    installLauncher({ script, dir: unrelated, appImage: '/elsewhere/Plasma.AppImage' });
    expect(repointAppImageWrappers([linked, other, unrelated], OLD, NEW)).toEqual([]);
    expect(readFileSync(join(other, 'plasma'), 'utf8')).toContain(OLD);
    expect(readlinkSync(join(linked, 'plasma'))).toBe(script);
  });
});
