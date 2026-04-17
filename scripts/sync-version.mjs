#!/usr/bin/env node
/**
 * Syncs the site's download URLs and filename labels to the version in
 * package.json. Runs automatically as the `version` npm lifecycle so
 * `pnpm version patch` bumps package.json AND patches site/index.html
 * in a single command.
 *
 * Single source of truth: package.json.version
 *   → electron-builder picks it up via ${version} in electron-builder.yml
 *   → this script pushes it into site/index.html
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const version = pkg.version;

const sitePath = resolve(root, 'site/index.html');
const before = readFileSync(sitePath, 'utf8');

// Patterns: Plasma-Setup-X.Y.Z-x64.exe and Plasma-Portable-X.Y.Z-x64.exe.
// Covers both the <a href="...">, data-download attr, and visible label.
const after = before
  .replace(/Plasma-Setup-\d+\.\d+\.\d+-x64\.exe/g, `Plasma-Setup-${version}-x64.exe`)
  .replace(/Plasma-Portable-\d+\.\d+\.\d+-x64\.exe/g, `Plasma-Portable-${version}-x64.exe`);

if (before === after) {
  console.log(`[sync-version] site already at ${version}, nothing to patch`);
} else {
  writeFileSync(sitePath, after);
  console.log(`[sync-version] site/index.html → ${version}`);
}
