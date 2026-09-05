#!/usr/bin/env node
/**
 * Uploads the current version's release artifacts to Cloudflare R2
 * via S3 PutObject (AWS SigV4) using only Node crypto + fetch — no
 * extra npm deps.
 *
 * Requires:
 *   - R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY in env
 *   - Windows artifacts already built via `pnpm run dist:win` (lives in release/)
 *   - Optional Mac artifacts from `pnpm run dist:mac` (DMG/ZIP/latest-mac.yml)
 *
 * Optional env (defaults match production):
 *   - R2_ACCOUNT_ID (945bc8f64778fda12f098a60e0ed122f)
 *   - R2_BUCKET (plasma)
 *   - R2_PUBLIC_BASE_URL (https://pub-05a2064511bc41689f299b542b07b67f.r2.dev)
 *   - R2_ENDPOINT (https://{accountId}.r2.cloudflarestorage.com)
 *
 * Usage:
 *   pnpm run release:upload
 */

import { createHash, createHmac } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const DEFAULT_ACCOUNT_ID = '945bc8f64778fda12f098a60e0ed122f';
const DEFAULT_BUCKET = 'plasma';
const DEFAULT_PUBLIC_BASE =
  'https://pub-05a2064511bc41689f299b542b07b67f.r2.dev';

// Load .env.local if present — drop R2 keys into a gitignored file instead
// of exporting every shell. Tiny parser; no dotenv dep. Existing
// process.env wins (shell > file).
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

const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
if (!accessKeyId || !secretAccessKey) {
  console.error('[upload] R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY not set');
  console.error('[upload] add to .env.local or export in shell');
  console.error(
    '[upload] Cloudflare → R2 → Manage R2 API Tokens (Object Read & Write)',
  );
  process.exit(1);
}

const accountId = process.env.R2_ACCOUNT_ID || DEFAULT_ACCOUNT_ID;
const bucket = process.env.R2_BUCKET || DEFAULT_BUCKET;
const publicBase = (
  process.env.R2_PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE
).replace(/\/$/, '');
const endpoint = (
  process.env.R2_ENDPOINT ||
  `https://${accountId}.r2.cloudflarestorage.com`
).replace(/\/$/, '');

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

const toUpload = artifacts.filter((a) =>
  existsSync(resolve(releaseDir, a.name)),
);

const fmtMB = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const REGION = 'auto';
const SERVICE = 's3';

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

function amzDate(d = new Date()) {
  // YYYYMMDDTHHMMSSZ
  return d.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

/**
 * PutObject to R2 with SigV4. Overwrites existing keys (stable public URLs).
 * @param {string} key
 * @param {Buffer} body
 * @param {string} contentType
 */
async function putObject(key, body, contentType) {
  const host = new URL(endpoint).host;
  const url = `${endpoint}/${bucket}/${encodeURIComponent(key).replace(/%2F/g, '/')}`;
  const now = new Date();
  const amz = amzDate(now);
  const dateStamp = amz.slice(0, 8);
  const payloadHash = sha256Hex(body);

  const headers = {
    host,
    'content-type': contentType,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amz,
  };

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((n) => `${n}:${headers[n]}\n`)
    .join('');
  const signedHeaders = signedHeaderNames.join(';');

  const canonicalRequest = [
    'PUT',
    `/${bucket}/${key}`,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amz,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning)
    .update(stringToSign)
    .digest('hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      ...headers,
      Authorization: authorization,
      'Content-Length': String(body.length),
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `PutObject ${key} failed: HTTP ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 300)}` : ''}`,
    );
  }

  return `${publicBase}/${key}`;
}

for (const { name, contentType } of toUpload) {
  const filePath = resolve(releaseDir, name);
  const size = statSync(filePath).size;
  console.log(`[upload] ${name} (${fmtMB(size)}) …`);

  const body = readFileSync(filePath);
  const url = await putObject(name, body, contentType);
  console.log(`[upload] ↪ ${url}`);
}

console.log('');
console.log('[upload] done. verify the site download links match:');
console.log(`  ${publicBase}/Plasma-Setup-${version}-x64.exe`);
console.log(`  ${publicBase}/Plasma-Portable-${version}-x64.exe`);
console.log(`  ${publicBase}/latest.yml          ← Win auto-update`);
if (toUpload.some((a) => a.name === 'latest-mac.yml')) {
  console.log(`  ${publicBase}/Plasma-${version}-arm64.dmg`);
  console.log(`  ${publicBase}/latest-mac.yml    ← Mac auto-update`);
}
