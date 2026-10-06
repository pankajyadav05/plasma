import { describe, expect, it } from 'vitest';
import {
  installPlan,
  isPerMachineInstall,
  platformInstaller,
  readPublisherName,
  resolveWindow,
  updatePolicy,
} from './update-policy';

describe('updatePolicy (C20)', () => {
  it('arms install-on-quit from the OS signature alone only when Windows verifies a publisher', () => {
    expect(updatePolicy('win32', 'Plasma Ltd')).toEqual({
      autoDownload: true,
      autoInstallOnAppQuit: true,
      signatureVerified: true,
    });
    expect(updatePolicy('win32', null).autoInstallOnAppQuit).toBe(false);
    expect(updatePolicy('darwin', null).autoInstallOnAppQuit).toBe(false);
    expect(updatePolicy('linux', 'x').signatureVerified).toBe(false);
  });
});

describe('readPublisherName', () => {
  it('parses scalar, inline-list and block-list forms', () => {
    expect(readPublisherName('provider: generic\npublisherName: Plasma Ltd\n')).toBe('Plasma Ltd');
    expect(readPublisherName("publisherName: ['Plasma Ltd']\n")).toBe('Plasma Ltd');
    expect(readPublisherName('publisherName:\n  - Plasma Ltd\nupdaterCacheDirName: x\n')).toBe(
      'Plasma Ltd',
    );
  });
  it('returns null when absent', () => {
    expect(readPublisherName('provider: generic\nurl: https://x\n')).toBeNull();
  });
});

describe('resolveWindow (C33)', () => {
  it('reads a getter on every call so a reopened window is followed', () => {
    let current: { id: number } | null = { id: 1 };
    const get = resolveWindow(() => current);
    expect(get()).toEqual({ id: 1 });
    current = null;
    expect(get()).toBeNull();
    current = { id: 2 };
    expect(get()).toEqual({ id: 2 });
  });
  it('wraps a fixed window', () => {
    const w = { id: 3 };
    expect(resolveWindow(w)()).toBe(w);
    expect(resolveWindow<{ id: number }>(null)()).toBeNull();
  });
});

describe('installPlan', () => {
  it('allows a silent install and install-on-quit once the signed manifest and the file hash passed', () => {
    expect(
      installPlan({ osSignatureVerified: false, trust: 'signed', fileVerified: true }),
    ).toEqual({
      silent: true,
      installOnQuit: true,
    });
  });

  it('does not trust a signed manifest until the downloaded file matched it', () => {
    expect(
      installPlan({ osSignatureVerified: false, trust: 'signed', fileVerified: false }),
    ).toEqual({
      silent: false,
      installOnQuit: false,
    });
  });

  it("keeps today's behaviour without a verified signature", () => {
    for (const trust of ['legacy', 'pending', 'unconfigured'] as const) {
      expect(installPlan({ osSignatureVerified: false, trust, fileVerified: true })).toEqual({
        silent: false,
        installOnQuit: false,
      });
    }
  });

  it('still honours an OS-verified publisher, but never a refused update', () => {
    expect(
      installPlan({ osSignatureVerified: true, trust: 'unconfigured', fileVerified: false }),
    ).toEqual({
      silent: true,
      installOnQuit: true,
    });
    expect(
      installPlan({ osSignatureVerified: true, trust: 'refused', fileVerified: true }),
    ).toEqual({
      silent: false,
      installOnQuit: false,
    });
  });
});

describe('platformInstaller', () => {
  it('installs through NSIS on Windows, but not from a portable EXE', () => {
    expect(platformInstaller({ platform: 'win32', env: {}, packageType: null })).toEqual({
      kind: 'nsis',
    });
    const portable = platformInstaller({
      platform: 'win32',
      env: { PORTABLE_EXECUTABLE_FILE: 'C:\\x\\Plasma.exe' },
      packageType: null,
    });
    expect(portable.kind).toBe('manual');
  });

  it('swaps an AppImage in place, but only a genuine one', () => {
    const mount = '/tmp/.mount_PlasmaAbc';
    const real = {
      platform: 'linux',
      env: { APPIMAGE: '/home/u/Plasma.AppImage', APPDIR: mount },
      packageType: null,
      resourcesPath: `${mount}/resources`,
    };
    expect(platformInstaller(real)).toEqual({ kind: 'appimage' });
    // APPIMAGE alone, or APPDIR somewhere else, is not enough
    expect(platformInstaller({ ...real, env: { APPIMAGE: '/home/u/Plasma.AppImage' } }).kind).toBe(
      'manual',
    );
    expect(platformInstaller({ ...real, resourcesPath: '/opt/Plasma/resources' }).kind).toBe(
      'manual',
    );
    expect(platformInstaller({ platform: 'linux', env: {}, packageType: null }).kind).toBe(
      'manual',
    );
  });

  it('never self-installs an OS package, even with APPIMAGE / APPDIR inherited from another app', () => {
    for (const packageType of ['deb', 'rpm', 'pacman']) {
      const r = platformInstaller({
        platform: 'linux',
        env: { APPIMAGE: '/home/u/Cursor.AppImage', APPDIR: '/tmp/.mount_Cursor' },
        packageType,
        resourcesPath: '/tmp/.mount_Cursor/resources',
      });
      expect(r.kind).toBe('manual');
    }
  });

  it('leaves an all-users Windows install to the user', () => {
    const env = {
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    };
    expect(
      platformInstaller({
        platform: 'win32',
        env,
        packageType: null,
        execPath: 'C:\\Program Files\\Plasma\\Plasma.exe',
      }).kind,
    ).toBe('manual');
    expect(
      platformInstaller({
        platform: 'win32',
        env,
        packageType: null,
        execPath: 'c:\\program files (x86)\\Plasma\\Plasma.exe',
      }).kind,
    ).toBe('manual');
    expect(
      platformInstaller({
        platform: 'win32',
        env,
        packageType: null,
        execPath: 'C:\\Users\\a\\AppData\\Local\\Programs\\Plasma\\Plasma.exe',
      }),
    ).toEqual({ kind: 'nsis' });
    expect(isPerMachineInstall('C:\\Program Files Evil\\x.exe', env)).toBe(false);
  });
});

describe('readPublisherName', () => {
  it('parses scalar, inline-list and block-list forms', () => {
    expect(readPublisherName('provider: generic\npublisherName: Plasma Ltd\n')).toBe('Plasma Ltd');
    expect(readPublisherName("publisherName: ['Plasma Ltd']\n")).toBe('Plasma Ltd');
    expect(readPublisherName('publisherName:\n  - Plasma Ltd\nupdaterCacheDirName: x\n')).toBe(
      'Plasma Ltd',
    );
  });
  it('returns null when absent', () => {
    expect(readPublisherName('provider: generic\nurl: https://x\n')).toBeNull();
  });
});

describe('resolveWindow (C33)', () => {
  it('reads a getter on every call so a reopened window is followed', () => {
    let current: { id: number } | null = { id: 1 };
    const get = resolveWindow(() => current);
    expect(get()).toEqual({ id: 1 });
    current = null;
    expect(get()).toBeNull();
    current = { id: 2 };
    expect(get()).toEqual({ id: 2 });
  });
  it('wraps a fixed window', () => {
    const w = { id: 3 };
    expect(resolveWindow(w)()).toBe(w);
    expect(resolveWindow<{ id: number }>(null)()).toBeNull();
  });
});
