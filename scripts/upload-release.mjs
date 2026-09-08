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
 * After uploading (or with --verify-only, on its own) it reads the public
 * feed back and fails unless latest.yml / latest-mac.yml advertise this
 * version and every file they reference is fetchable.
 *
 * Usage:
 *   pnpm run release:upload
 *   pnpm run release:verify   # no credentials needed; read-only check
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

// `--verify-only` skips the uploads and just asserts that the public feed
// serves this version — usable without R2 credentials (read-only HTTP).
const verifyOnly = process.argv.includes('--verify-only');

const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
if (!verifyOnly && (!accessKeyId || !secretAccessKey)) {
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
if (!verifyOnly && requiredMissing.length > 0) {
  console.error('[upload] missing required Windows artifacts in release/:');
  for (const m of requiredMissing) console.error(`  - ${m.name}`);
  console.error('[upload] run `pnpm run dist:win` first');
  process.exit(1);
}

const optionalMissing = artifacts.filter(
  (a) => !a.required && !existsSync(resolve(releaseDir, a.name)),
);
if (!verifyOnly && optionalMissing.length > 0) {
  console.log('[upload] skipping missing Mac artifacts (Windows-only upload?):');
  for (const m of optionalMissing) console.log(`  - ${m.name}`);
}

const toUpload = verifyOnly
  ? []
  : artifacts.filter((a) => existsSync(resolve(releaseDir, a.name)));

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
 * Cache policy. `latest.yml` / `latest-mac.yml` are mutable pointers
 * rewritten under the same key every release, so every intermediary must
 * revalidate — a cached manifest tells clients an old build is current.
 * Binaries carry the version in their key and never change.
 * @param {string} key
 */
function cacheControlFor(key) {
  return key.endsWith('.yml')
    ? 'no-cache, must-revalidate'
    : 'public, max-age=31536000, immutable';
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
    'cache-control': cacheControlFor(key),
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

// ── Post-publish gate ────────────────────────────────────────────────
// A release is only shipped when the *public* feed says so. Every stuck
// updater so far was silent: the manifest on the CDN kept advertising an
// older version (publish job never ran, upload partially failed, feed URL
// abandoned) while the tag, the GitHub release and the site all looked
// fine. Read the feed back over plain HTTP and fail loudly if it does not
// serve this version, with every file it references actually present.

/**
 * @param {string} name manifest key (`latest.yml` / `latest-mac.yml`)
 * @returns {Promise<string[]>} problems found; empty means healthy
 */
async function verifyManifest(name) {
  const problems = [];
  // Cache-buster: electron-updater appends one too, so this mirrors what
  // a real client fetches rather than whatever an edge cache holds.
  const url = `${publicBase}/${name}?noCache=${Date.now()}`;
  const res = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) {
    return [`${name}: HTTP ${res.status} ${res.statusText}`];
  }
  const body = await res.text();

  const declared = body.match(/^version:\s*['"]?([^'"\s]+)/m)?.[1];
  if (declared !== version) {
    problems.push(`${name}: advertises version ${declared ?? '(none)'}, expected ${version}`);
  }

  const referenced = [...body.matchAll(/^\s*-\s*url:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  if (referenced.length === 0) {
    problems.push(`${name}: lists no files`);
  }
  for (const file of referenced) {
    const fileUrl = /^https?:/.test(file) ? file : `${publicBase}/${file}`;
    const head = await fetch(fileUrl, { method: 'HEAD' });
    if (!head.ok) {
      problems.push(`${name}: references ${file} — HTTP ${head.status}`);
    }
  }
  return problems;
}

// Windows manifest always. Mac manifest whenever it was part of this
// publish, or always in --verify-only mode (CI publishes both platforms;
// a Windows-only local ship deliberately leaves latest-mac.yml behind).
const manifests = ['latest.yml'];
if (verifyOnly || toUpload.some((a) => a.name === 'latest-mac.yml')) {
  manifests.push('latest-mac.yml');
}

console.log('');
const problems = [];
for (const name of manifests) {
  console.log(`[verify] ${publicBase}/${name} …`);
  problems.push(...(await verifyManifest(name)));
}

if (problems.length > 0) {
  console.error('');
  console.error(`[verify] update feed is NOT serving ${version}:`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error('[verify] clients will keep reporting the previous version as latest');
  process.exit(1);
}

console.log('');
console.log(`[verify] feed serves ${version} — ${manifests.join(', ')} healthy`);
console.log('[upload] done. site download links:');
console.log(`  ${publicBase}/Plasma-Setup-${version}-x64.exe`);
console.log(`  ${publicBase}/Plasma-Portable-${version}-x64.exe`);
console.log(`  ${publicBase}/latest.yml          ← Win auto-update`);
if (manifests.includes('latest-mac.yml')) {
  console.log(`  ${publicBase}/Plasma-${version}-arm64.dmg`);
  console.log(`  ${publicBase}/latest-mac.yml    ← Mac auto-update`);
}
