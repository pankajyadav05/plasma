#!/usr/bin/env node
/**
 * Rebuild native modules (better-sqlite3) against Electron's ABI after install.
 *
 * Runs automatically via the `postinstall` script in package.json so a local
 * `pnpm install` leaves a working dev environment.
 *
 * Skipped on CI: a bare `electron-rebuild` exits non-zero on the GitHub Actions
 * macOS runner (255) before the build starts. The release workflow instead runs
 * `pnpm exec electron-builder install-app-deps` right after install, which
 * rebuilds the same native deps against the exact Electron version it packages.
 */

import { spawnSync } from 'node:child_process'

if (process.env.CI) {
  console.log('[postinstall] CI detected, skipping electron-rebuild (CI runs `electron-builder install-app-deps` instead)')
  process.exit(0)
}

const result = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['electron-rebuild', '-f', '-w', 'better-sqlite3'],
  { stdio: 'inherit' }
)
process.exit(result.status ?? 1)
