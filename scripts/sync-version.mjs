#!/usr/bin/env node
/**
 * Syncs the site's version literal to the version in package.json. Runs
 * automatically as part of the release flow so `pnpm run release:patch`
 * bumps package.json AND patches site/lib/version.ts in a single command.
 *
 * Single source of truth: package.json.version
 *   → electron-builder picks it up via ${version} in electron-builder.yml
 *   → this script pushes it into site/lib/version.ts (Next.js site reads it)
 *
 * Patching lives in scripts/lib/sync-site-version.mjs (shared with release.mjs).
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncSiteVersion } from './lib/sync-site-version.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const version = pkg.version;

const sitePath = resolve(root, 'site/lib/version.ts');
const { changed } = syncSiteVersion(sitePath, version);

if (!changed) {
  console.log(`[sync-version] site already at ${version}, nothing to patch`);
} else {
  console.log(`[sync-version] site/lib/version.ts → ${version}`);
}
