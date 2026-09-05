#!/usr/bin/env node
/**
 * Uploads the current version's release artifacts to Vercel Blob.
 *
 * Requires:
 *   - BLOB_READ_WRITE_TOKEN in env (from Vercel dashboard → Storage → Blob)
 *   - Windows artifacts already built via `pnpm run dist:win` (lives in release/)
 *   - Optional Mac artifacts from `pnpm run dist:mac` (DMG/ZIP/latest-mac.yml)
 *
 * Usage:
 *   pnpm run release:upload
 *
 * Uploads Windows installer + portable + manifests, and any present Mac
 * artifacts, to the blob store root. `addRandomSuffix: false` keeps URLs
 * stable and matching the hrefs baked into site/index.html.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { put } from '@vercel/blob';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// Load .env.local if present — lets the user drop the Vercel token into a
// gitignored file instead of exporting it every shell. Tiny parser; no
// dotenv dep. Existing process.env wins (shell > file).
const envPath = resolve(root, '.env.local');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (!m) continue;
    const [, key, rawVal] = m;
    if (process.env[key]) continue;
    const val = rawVal.replace(/^['"]|['"]$/g, '');
    process.env[key] = val;
  }
}

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error('[upload] BLOB_READ_WRITE_TOKEN not set');
  console.error('[upload] add to .env.local or export in shell');
  console.error('[upload] grab from Vercel → Storage → Blob → .env.local');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const version = pkg.version;

/** @type {{ name: string, contentType: string, required?: boolean }[]} */
const artifacts = [
  // Windows — installer + blockmap (delta updates) + portable + manifest.
  // Required: fail fast if the Win build wasn't run.
  {
    name: `Plasma-Setup-${version}-x64.exe`,
    contentType: 'application/vnd.microsoft.portable-executable',
    required: true,
  },
  {
    name: `Plasma-Setup-${version}-x64.exe.blockmap`,
    contentType: 'application/octet-stream',
    required: true,
  },
  {
    name: `Plasma-Portable-${version}-x64.exe`,
    contentType: 'application/vnd.microsoft.portable-executable',
    required: true,
  },
  { name: 'latest.yml', contentType: 'text/yaml', required: true },

  // macOS — DMG (user download) + ZIP (electron-updater) for arm64 + x64,
  // plus latest-mac.yml and any blockmaps electron-builder emitted.
  // Optional so a Windows-only local upload still works; CI builds both.
  {
    name: `Plasma-${version}-arm64.dmg`,
    contentType: 'application/x-apple-diskimage',
  },
  {
    name: `Plasma-${version}-x64.dmg`,
    contentType: 'application/x-apple-diskimage',
  },
  { name: `Plasma-${version}-arm64.zip`, contentType: 'application/zip' },
  { name: `Plasma-${version}-x64.zip`, contentType: 'application/zip' },
  {
    name: `Plasma-${version}-arm64.zip.blockmap`,
    contentType: 'application/octet-stream',
  },
  {
    name: `Plasma-${version}-x64.zip.blockmap`,
    contentType: 'application/octet-stream',
  },
  {
    name: `Plasma-${version}-arm64.dmg.blockmap`,
    contentType: 'application/octet-stream',
  },
  {
    name: `Plasma-${version}-x64.dmg.blockmap`,
    contentType: 'application/octet-stream',
  },
  { name: 'latest-mac.yml', contentType: 'text/yaml' },
];

const releaseDir = resolve(root, 'release');
const requiredMissing = artifacts.filter(
  (a) => a.required && !existsSync(resolve(releaseDir, a.name)),
);
if (requiredMissing.length > 0) {
  console.error('[upload] missing required Windows artifacts in release/:');
  for (const m of requiredMissing) console.error(`  - ${m.name}`);
  console.error('[upload] run `pnpm run dist:win` first');
  process.exit(1);
}

const optionalMissing = artifacts.filter(
  (a) => !a.required && !existsSync(resolve(releaseDir, a.name)),
);
if (optionalMissing.length > 0) {
  console.log('[upload] skipping missing Mac artifacts (Windows-only upload?):');
  for (const m of optionalMissing) console.log(`  - ${m.name}`);
}

const toUpload = artifacts.filter((a) => existsSync(resolve(releaseDir, a.name)));

const fmtMB = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

for (const { name, contentType } of toUpload) {
  const filePath = resolve(releaseDir, name);
  const size = statSync(filePath).size;
  console.log(`[upload] ${name} (${fmtMB(size)}) …`);

  const body = readFileSync(filePath);
  const result = await put(name, body, {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType,
  });
  console.log(`[upload] ↪ ${result.url}`);
}

console.log('');
console.log('[upload] done. verify the site download links match:');
console.log(`  https://<your-blob-host>/Plasma-Setup-${version}-x64.exe`);
console.log(`  https://<your-blob-host>/Plasma-Portable-${version}-x64.exe`);
console.log(`  https://<your-blob-host>/latest.yml          ← Win auto-update`);
if (toUpload.some((a) => a.name === 'latest-mac.yml')) {
  console.log(`  https://<your-blob-host>/Plasma-${version}-arm64.dmg`);
  console.log(`  https://<your-blob-host>/latest-mac.yml    ← Mac auto-update`);
}
