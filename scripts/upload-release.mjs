#!/usr/bin/env node
/**
 * Uploads the current version's release artifacts to Vercel Blob.
 *
 * Requires:
 *   - BLOB_READ_WRITE_TOKEN in env (from Vercel dashboard → Storage → Blob)
 *   - artifacts already built via `pnpm run dist:win` (lives in release/)
 *
 * Usage:
 *   pnpm run release:upload
 *
 * Uploads `Plasma-Setup-${version}-x64.exe` and `Plasma-Portable-${version}-x64.exe`
 * to the blob store root. `addRandomSuffix: false` keeps URLs stable and
 * matching the hrefs baked into site/index.html.
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

const artifacts = [
  // The installer + its blockmap (delta updates) and the manifest
  // electron-updater polls. The portable EXE has no blockmap and is
  // not auto-updatable but still ships for direct download.
  {
    name: `Plasma-Setup-${version}-x64.exe`,
    contentType: 'application/vnd.microsoft.portable-executable',
  },
  { name: `Plasma-Setup-${version}-x64.exe.blockmap`, contentType: 'application/octet-stream' },
  {
    name: `Plasma-Portable-${version}-x64.exe`,
    contentType: 'application/vnd.microsoft.portable-executable',
  },
  { name: 'latest.yml', contentType: 'text/yaml' },
];

// Fail fast if anything's missing — better to know before uploading half.
const missing = artifacts.filter((a) => !existsSync(resolve(root, 'release', a.name)));
if (missing.length > 0) {
  console.error(`[upload] missing artifacts in release/:`);
  for (const m of missing) console.error(`  - ${m.name}`);
  console.error('[upload] run `pnpm run dist:win` first');
  process.exit(1);
}

const fmtMB = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

for (const { name, contentType } of artifacts) {
  const filePath = resolve(root, 'release', name);
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
console.log(`  https://<your-blob-host>/latest.yml          ← auto-update manifest`);
