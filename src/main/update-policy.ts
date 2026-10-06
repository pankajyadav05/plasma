/** Pure update-policy helpers (no electron-updater import, so unit-testable). */

/**
 * Update integrity and what it allows.
 *
 * Two independent proofs can vouch for an update:
 *
 * 1. Our own signed manifest (SC-01, `update-signing.ts`): every manifest is
 *    ed25519-signed with a key that never leaves the release machine, the key
 *    is pinned in the app, and the downloaded file is re-hashed against the
 *    signed sha512 (`checkDownloadedFile`). That is real integrity without OS
 *    code signing, so it is what lets an unsigned build install silently.
 * 2. OS code signing: on Windows, when the build is signed and `publisherName`
 *    is set (electron-builder writes it into app-update.yml), electron-updater
 *    verifies the installer's Authenticode signature against it. On macOS,
 *    Squirrel.Mac only accepts updates signed like the running app (a
 *    Developer ID; see docs/mac-auto-update.md).
 *
 * Silent installs ("Restart to update" without installer windows, and
 * install-on-quit) need at least one of the two to have passed for the exact
 * version and file in hand. Without either, Plasma still downloads in the
 * background, but never installs on quit and the explicit button runs the
 * installer with its normal windows. Downgrades and prereleases are always
 * refused.
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

/** Outcome of the signed-manifest check for the update in flight. */
export type UpdateTrust =
  /** Not checked yet. */
  | 'pending'
  /** `<manifest>.sig` verified and agrees with what electron-updater parsed. */
  | 'signed'
  /** No `.sig`, tolerated because the version predates `SIGNED_UPDATES_REQUIRED_FROM`. */
  | 'legacy'
  /** Failed the check: never install. */
  | 'refused'
  /** No signing key embedded in this build. */
  | 'unconfigured';

export type InstallPlan = {
  /** Run the installer with no windows, relaunch afterwards. */
  silent: boolean;
  /** Install when the user simply quits. */
  installOnQuit: boolean;
};

/**
 * What a downloaded update may do. `fileVerified` means the file on disk was
 * re-hashed against the sha512 of the signed manifest and matched.
 */
export function installPlan(input: {
  osSignatureVerified: boolean;
  trust: UpdateTrust;
  fileVerified: boolean;
}): InstallPlan {
  if (input.trust === 'refused') return { silent: false, installOnQuit: false };
  const signedByUs = input.trust === 'signed' && input.fileVerified;
  const silent = signedByUs || input.osSignatureVerified;
  return { silent, installOnQuit: silent };
}

export type PlatformInstaller = { kind: 'nsis' | 'appimage' } | { kind: 'manual'; reason: string };

/**
 * True when `execPath` sits in a per-machine ("all users") install location.
 * Updating that one means running the installer elevated, which must never be
 * done with a file from a user-writable cache folder.
 */
export function isPerMachineInstall(
  execPath: string,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const norm = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const exe = norm(execPath);
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432]
    .filter((r): r is string => Boolean(r))
    .map(norm);
  return roots.some((r) => exe.startsWith(`${r}\\`));
}

/**
 * Which updater class can really replace this install on Windows and Linux,
 * decided from the packaged app itself, never from inherited environment
 * alone. macOS is decided in `updater.ts` (it depends on the bundle's
 * signature and location). `packageType` is the content of
 * `resources/package-type` (electron-updater picks its class from the same
 * file), so any value there means an OS package: manual. An AppImage is only
 * accepted when `APPIMAGE` is set AND the app's own resources live inside
 * `APPDIR`, the runtime's mount: a .deb started from a terminal inside another
 * AppImage inherits both variables but not that location.
 */
export function platformInstaller(input: {
  platform: string;
  env: Readonly<Record<string, string | undefined>>;
  packageType: string | null;
  /** `process.resourcesPath`. */
  resourcesPath?: string;
  /** `process.execPath`. */
  execPath?: string;
}): PlatformInstaller {
  if (input.platform === 'win32') {
    if (input.env.PORTABLE_EXECUTABLE_FILE) {
      return {
        kind: 'manual',
        reason: 'The portable build cannot update itself. Download the new version.',
      };
    }
    if (input.execPath && isPerMachineInstall(input.execPath, input.env)) {
      return {
        kind: 'manual',
        reason:
          'This is an all-users install, which needs administrator rights to update. Download the new installer and run it.',
      };
    }
    return { kind: 'nsis' };
  }
  if (input.platform === 'linux') {
    if (input.packageType != null) {
      // electron-updater would run `dpkg -i` (or rpm / pacman) as root through pkexec on a
      // file that sits in a user-writable cache folder: anything running as this user could
      // swap it after our check. So OS packages stay a manual step.
      return {
        kind: 'manual',
        reason:
          'A package install needs administrator rights. Download the new package and install it.',
      };
    }
    const appDir = input.env.APPDIR;
    const res = input.resourcesPath;
    if (
      input.env.APPIMAGE &&
      appDir &&
      res &&
      (res === appDir || res.startsWith(`${appDir.replace(/\/+$/, '')}/`))
    ) {
      return { kind: 'appimage' };
    }
    return {
      kind: 'manual',
      reason: 'This install cannot update itself. Download the new version.',
    };
  }
  return {
    kind: 'manual',
    reason: 'This platform cannot update itself. Download the new version.',
  };
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
