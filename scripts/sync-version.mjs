#!/usr/bin/env node
/**
 * Syncs the site's version literal to the version in package.json. Runs
 * automatically as part of the release flow so `pnpm run release:patch`
 * bumps package.json AND patches site/lib/version.ts in a single command.
 *
 * Single source of truth: package.json.version
 *   → electron-builder picks it up via ${version} in electron-builder.yml
 *   → this script pushes it into site/lib/version.ts (Next.js site reads it)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const version = pkg.version;

const sitePath = resolve(root, 'site/lib/version.ts');
const before = readFileSync(sitePath, 'utf8');

// Patch:
//   export const VERSION = '0.0.10';
//   …Plasma-Setup-0.0.10-x64.exe…
//   …Plasma-Portable-0.0.10-x64.exe…
const after = before
  .replace(/(export const VERSION\s*=\s*')([^']+)(')/, `$1${version}$3`)
  .replace(/Plasma-Setup-\d+\.\d+\.\d+-x64\.exe/g, `Plasma-Setup-${version}-x64.exe`)
  .replace(/Plasma-Portable-\d+\.\d+\.\d+-x64\.exe/g, `Plasma-Portable-${version}-x64.exe`)
  // macOS DMGs
  .replace(/Plasma-\d+\.\d+\.\d+-arm64\.dmg/g, `Plasma-${version}-arm64.dmg`)
  .replace(/Plasma-\d+\.\d+\.\d+-x64\.dmg/g, `Plasma-${version}-x64.dmg`);

if (before === after) {
  console.log(`[sync-version] site already at ${version}, nothing to patch`);
} else {
  writeFileSync(sitePath, after);
  console.log(`[sync-version] site/lib/version.ts → ${version}`);
}
