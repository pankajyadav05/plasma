#!/usr/bin/env node
/**
 * Post-install: make sure the Electron binary is present for `pnpm dev`.
 *
 * Nothing is rebuilt here. better-sqlite3 13 ships N-API prebuilds for every
 * platform/arch (`prebuilds/<platform>-<arch>.node`, no install script), and
 * N-API binaries load in Electron unchanged, so there is no electron-rebuild
 * step and no compiler toolchain requirement (this used to break Windows
 * installs: `npx.cmd` without a shell is EINVAL on current Node).
 *
 * This script never fails the install. Packaging does not need
 * node_modules/electron/dist (electron-builder downloads its own), so a failed
 * Electron download is only a warning; `pnpm dev` will say what is missing.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/**
 * pnpm doesn't always run electron's own install script (e.g. after the
 * version in the lockfile changes), and on macOS that script can also fail:
 * Electron 44 needs Node >= 22.12 (it require()s an ESM extractor) and its
 * native unzip binding can be blocked by the OS. Either way node_modules/electron
 * is left without its binary and `pnpm dev` fails with "Electron uninstall".
 * Try electron's installer first, then fall back to downloading the zip with
 * @electron/get and unpacking it with the system's own tools.
 */
function electronBinaryPath(dir) {
  const pathTxt = join(dir, 'path.txt')
  if (!existsSync(pathTxt)) return null
  const binary = join(dir, 'dist', readFileSync(pathTxt, 'utf8').trim())
  return existsSync(binary) ? binary : null
}

function platformPath() {
  if (process.platform === 'darwin') return 'Electron.app/Contents/MacOS/Electron'
  if (process.platform === 'win32') return 'electron.exe'
  return 'electron'
}

/** Escape a value for a single-quoted PowerShell string. */
function psQuote(value) {
  return value.replaceAll("'", "''")
}

async function fallbackInstall(dir) {
  const req = createRequire(join(dir, 'package.json'))
  const { version } = req('./package.json')
  const { downloadArtifact } = req('@electron/get')
  const zip = await downloadArtifact({
    version,
    artifactName: 'electron',
    platform: process.platform,
    arch: process.arch,
    checksums: req('./checksums.json'),
  })
  const dist = join(dir, 'dist')
  rmSync(dist, { recursive: true, force: true })
  mkdirSync(dist, { recursive: true })
  // ditto keeps the .app bundle's symlinks and permissions intact on macOS.
  const unzip =
    process.platform === 'darwin'
      ? spawnSync('ditto', ['-x', '-k', zip, dist], { stdio: 'inherit' })
      : process.platform === 'win32'
        ? spawnSync(
            'powershell',
            [
              '-NoProfile',
              '-Command',
              `Expand-Archive -Force -LiteralPath '${psQuote(zip)}' -DestinationPath '${psQuote(dist)}'`,
            ],
            { stdio: 'inherit' },
          )
        : spawnSync('unzip', ['-q', '-o', zip, '-d', dist], { stdio: 'inherit' })
  if (unzip.status !== 0) throw new Error('unzip failed')
  const types = join(dist, 'electron.d.ts')
  if (existsSync(types)) renameSync(types, join(dir, 'electron.d.ts'))
  writeFileSync(join(dir, 'path.txt'), platformPath())
}

async function ensureElectronBinary() {
  let dir
  try {
    dir = dirname(createRequire(import.meta.url).resolve('electron/package.json'))
  } catch {
    return
  }
  if (electronBinaryPath(dir)) return
  console.log('[postinstall] Electron binary missing, downloading it')
  spawnSync(process.execPath, [join(dir, 'install.js')], { stdio: 'inherit', cwd: dir })
  if (electronBinaryPath(dir)) return
  console.log('[postinstall] electron install.js failed, using the fallback download')
  try {
    await fallbackInstall(dir)
  } catch (err) {
    console.warn(`[postinstall] ${err instanceof Error ? err.message : err}`)
  }
  if (!electronBinaryPath(dir)) {
    console.warn(
      `[postinstall] Could not install Electron (Node ${process.version}; Electron 44 needs >= 22.12). ` +
        'Continuing: packaging downloads its own copy, `pnpm dev` needs this one.',
    )
  }
}

// CI jobs that never launch Electron set ELECTRON_SKIP_BINARY_DOWNLOAD (and
// packaging does not need node_modules/electron/dist), so honour both.
if (process.env.CI || process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
  console.log('[postinstall] CI / ELECTRON_SKIP_BINARY_DOWNLOAD set, skipping the Electron binary check')
} else {
  try {
    await ensureElectronBinary()
  } catch (err) {
    console.warn(`[postinstall] ${err instanceof Error ? err.message : err}`)
  }
}
process.exit(0)
