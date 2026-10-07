// electron-builder afterPack hook: Electron fuses for every platform, plus the
// Linux launcher that keeps the AppImage starting on Ubuntu 24.04+.
//
// Fuses are flipped here, not through `electronFuses` in electron-builder.yml,
// because on Linux the Electron binary is renamed afterwards and electron-builder
// flips fuses after this hook, on whatever file is called `plasma`.
const { chmodSync, existsSync, renameSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

/**
 * `runAsNode` stays off, so ELECTRON_RUN_AS_NODE does nothing in a packaged
 * build. The stdio MCP bridge (`plasma mcp`) therefore starts the app binary
 * with `--plasma-mcp-bridge`, which src/main/index.ts handles before it takes
 * the single-instance lock or opens a window. The Linux launcher below passes
 * every argument through, so nothing else is needed here.
 *
 * SC-28. Verify a packaged binary with `node scripts/verify-fuses.mjs <binary>`. */
const FUSES = {
  runAsNode: false,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  onlyLoadAppFromAsar: true,
  // Electron honours this on macOS and Windows only; Linux ignores the fuse.
  enableEmbeddedAsarIntegrityValidation: true,
  // Flipping fuses edits the Electron framework after its (linker, ad-hoc)
  // signature was made, and mac builds are not signed afterwards
  // (`mac.identity: null`), so macOS killed 3.1.2 at launch ("Code Signature
  // Invalid"). This re-signs the .app ad-hoc; a no-op on other platforms.
  resetAdHocDarwinSignature: true,
};

/**
 * Ubuntu 24.04+ restricts unprivileged user namespaces through AppArmor.
 * Chromium then falls back to its setuid `chrome-sandbox`, which inside an
 * AppImage (a FUSE mount) can never be root-owned, so Electron aborts:
 * "The SUID sandbox helper binary was found, but is not configured correctly".
 * The .deb installs an AppArmor profile (build/apparmor-profile) and keeps the
 * sandbox. The AppImage cannot, so only there, and only when the kernel blocks
 * the sandbox, this launcher starts Electron with --no-sandbox.
 */
const LAUNCHER = `#!/bin/sh
# Plasma launcher (scripts/after-pack.cjs). The Electron binary is plasma.bin.
HERE="$(dirname "$(readlink -f "$0")")"
BIN="$HERE/plasma.bin"
if [ -n "$APPIMAGE" ] && [ ! -u "$HERE/chrome-sandbox" ]; then
  blocked=0
  [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = "1" ] && blocked=1
  [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null)" = "0" ] && blocked=1
  [ "$(cat /proc/sys/user/max_user_namespaces 2>/dev/null)" = "0" ] && blocked=1
  if [ "$blocked" = "1" ]; then
    echo "Plasma: this system blocks the Chromium sandbox for AppImages, so Plasma starts without it. Install the .deb package to keep the sandbox." >&2
    exec "$BIN" --no-sandbox "$@"
  fi
fi
exec "$BIN" "$@"
`;

exports.default = async function afterPack(context) {
  const { packager, appOutDir, electronPlatformName } = context;
  await packager.addElectronFuses(context, packager.generateFuseConfig(FUSES));

  if (electronPlatformName !== 'linux') return;
  const exe = join(appOutDir, packager.executableName);
  const bin = `${exe}.bin`;
  if (existsSync(bin)) return; // already wrapped (re-run on the same output)
  renameSync(exe, bin);
  writeFileSync(exe, LAUNCHER);
  chmodSync(exe, 0o755);
};
