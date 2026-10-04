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
 * feed back and fails unless latest.yml / latest-mac.yml / latest-linux.yml
 * advertise this version, every file they reference is fetchable with the
 * size the manifest declares, and (when a signing key is configured) the
 * published `<manifest>.sig` verifies.
 *
 * Signed manifests (SC-01): every manifest is signed with the ed25519 key in
 * PLASMA_UPDATE_SIGNING_KEY (.env.local, see `pnpm gen:update-key`) and
 * uploaded as `<manifest>.sig`. Pass --allow-unsigned to publish without
 * (only before the app enforces signatures, see docs/release.md).
 *
 * Versioned binaries are immutable: they are written with `If-None-Match: *`
 * and a re-run only skips ones whose published size already matches. A
 * different file under the same version is a hard error (bump the version).
 *
 * Usage:
 *   pnpm run release:upload
 *   pnpm run release:mac      # dist:mac + upload --mac-only (no Windows build)
 *   pnpm run release:linux    # dist:linux + upload --linux-only
 *   pnpm run release:verify   # no credentials needed; read-only check
 */

import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
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
// `--mac-only` publishes just the macOS build: the Windows artifacts and
// latest.yml are left as they are (Windows users stay on the previous version).
const macOnly = process.argv.includes('--mac-only');
// `--linux-only` publishes just the Linux build (AppImage + deb + latest-linux.yml).
const linuxOnly = process.argv.includes('--linux-only');
// Publish manifests without a signature. Only valid while the app still accepts
// unsigned feeds (before SIGNED_UPDATES_REQUIRED_FROM in update-signing-key.ts).
const allowUnsigned = process.argv.includes('--allow-unsigned');

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

  // Linux — AppImage (self-updating) + deb (manual) + latest-linux.yml.
  // Optional so Windows/macOS-only ships keep working.
  {
    name: `Plasma-${version}-x86_64.AppImage`,
    contentType: 'application/octet-stream',
  },
  {
    name: `Plasma-${version}-x86_64.AppImage.blockmap`,
    contentType: 'application/octet-stream',
  },
  {
    name: `Plasma-${version}-amd64.deb`,
    contentType: 'application/vnd.debian.binary-package',
  },
  { name: 'latest-linux.yml', contentType: 'text/yaml' },
];

const isWindowsFile = (name) =>
  name.endsWith('.exe') || name.includes('.exe.') || name === 'latest.yml';
const isLinuxFile = (name) =>
  name.endsWith('.AppImage') ||
  name.includes('.AppImage.') ||
  name.endsWith('.deb') ||
  name === 'latest-linux.yml';

if (macOnly || linuxOnly) {
  const wanted = macOnly
    ? (name) => !isWindowsFile(name) && !isLinuxFile(name)
    : isLinuxFile;
  for (const a of artifacts) {
    // The update feed and every installer of the chosen platform must be there.
    a.required = wanted(a.name) && !a.name.endsWith('.blockmap');
  }
  artifacts.splice(0, artifacts.length, ...artifacts.filter((a) => wanted(a.name)));
} else {
  // A default (Windows) ship does not require the Linux build.
  for (const a of artifacts) if (isLinuxFile(a.name)) a.required = false;
}

const releaseDir = resolve(root, 'release');
const requiredMissing = artifacts.filter(
  (a) => a.required && !existsSync(resolve(releaseDir, a.name)),
);
if (!verifyOnly && requiredMissing.length > 0) {
  console.error(`[upload] missing required ${macOnly ? 'macOS' : linuxOnly ? 'Linux' : 'Windows'} artifacts in release/:`);
  for (const m of requiredMissing) console.error(`  - ${m.name}`);
  console.error(`[upload] run \`pnpm run ${macOnly ? 'dist:mac' : linuxOnly ? 'dist:linux' : 'dist:win'}\` first`);
  process.exit(1);
}

const optionalMissing = artifacts.filter(
  (a) => !a.required && !existsSync(resolve(releaseDir, a.name)),
);
if (!verifyOnly && optionalMissing.length > 0) {
  console.log(`[upload] skipping missing optional artifacts${macOnly || linuxOnly ? '' : ' (Windows-only upload?)'}:`);
  for (const m of optionalMissing) console.log(`  - ${m.name}`);
}

const toUpload = verifyOnly
  ? []
  : artifacts.filter((a) => {
      const path = resolve(releaseDir, a.name);
      if (!existsSync(path)) return false;
      // A leftover manifest from an earlier build must never be (re)published
      // as if it belonged to this version.
      if (a.name.startsWith('latest') && a.name.endsWith('.yml')) {
        const declared = readFileSync(path, 'utf8').match(/^version:\s*['"]?([^'"\s]+)/m)?.[1];
        if (declared !== version) {
          console.log(`[upload] skipping ${a.name}: it is for ${declared ?? '?'}, not ${version}`);
          return false;
        }
      }
      return true;
    });

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
  return isMutable(key) ? 'no-cache, must-revalidate' : 'public, max-age=31536000, immutable';
}

/** Mutable pointers: the manifests and their detached signatures. */
function isMutable(key) {
  return key.endsWith('.yml') || key.endsWith('.yml.sig');
}

/**
 * PutObject to R2 with SigV4. Manifests (and their .sig) overwrite their
 * stable key; every other key is versioned and immutable, so it is written
 * with `If-None-Match: *` and an existing object is never replaced (SC-22).
 * @param {string} key
 * @param {Buffer} body
 * @param {string} contentType
 * @returns {Promise<{ url: string, existed: boolean }>}
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
    ...(isMutable(key) ? {} : { 'if-none-match': '*' }),
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

  if (res.status === 412) return { url: `${publicBase}/${key}`, existed: true };
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `PutObject ${key} failed: HTTP ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 300)}` : ''}`,
    );
  }

  return { url: `${publicBase}/${key}`, existed: false };
}

// ── Manifest signing (SC-01) ─────────────────────────────────────────
const MANIFESTS = ['latest.yml', 'latest-mac.yml', 'latest-linux.yml'];

/** Private key from PLASMA_UPDATE_SIGNING_KEY (base64 PKCS#8 DER), or null. */
function loadSigningKey() {
  const raw = process.env.PLASMA_UPDATE_SIGNING_KEY;
  if (!raw) return null;
  try {
    return createPrivateKey({ key: Buffer.from(raw, 'base64'), format: 'der', type: 'pkcs8' });
  } catch (err) {
    console.error(`[sign] PLASMA_UPDATE_SIGNING_KEY is not a valid key: ${err.message}`);
    process.exit(1);
  }
}

/** Public key embedded in the app (src/main/update-signing-key.ts), or null. */
function embeddedPublicKey() {
  const src = readFileSync(resolve(root, 'src/main/update-signing-key.ts'), 'utf8');
  // Either quote style: the app reads both, so the release check must too.
  return /UPDATE_SIGNING_PUBLIC_KEY:\s*string\s*\|\s*null\s*=\s*(['"])([^'"]+)\1/.exec(src)?.[2] ?? null;
}

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const rawPublicOf = (privateKey) =>
  createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');

const signingKey = loadSigningKey();
if (!verifyOnly && !signingKey && !allowUnsigned) {
  console.error('[sign] PLASMA_UPDATE_SIGNING_KEY is not set: refusing to publish unsigned manifests.');
  console.error('[sign] run `pnpm gen:update-key` once, or pass --allow-unsigned (transition only).');
  process.exit(1);
}
if (signingKey) {
  const embedded = embeddedPublicKey();
  if (embedded == null) {
    console.warn('[sign] WARNING: no public key is embedded in src/main/update-signing-key.ts yet;');
    console.warn('[sign]          shipped apps cannot verify these signatures until you paste it and release.');
  } else if (embedded !== rawPublicOf(signingKey)) {
    console.error('[sign] PLASMA_UPDATE_SIGNING_KEY does not match the public key embedded in the app.');
    console.error('[sign] Installed apps would reject every update. Fix the key or the embedded value.');
    process.exit(1);
  }
}

/** Detached ed25519 signature (base64) over the manifest's exact bytes. */
function signManifest(bytes) {
  const signature = sign(null, bytes, signingKey);
  if (!verify(null, bytes, createPublicKey(signingKey), signature)) {
    throw new Error('freshly made signature does not verify');
  }
  return signature.toString('base64');
}

/** Streams a file through sha512 (installers are 100 MB+). */
function sha512Base64(path) {
  return new Promise((res, rej) => {
    const hash = createHash('sha512');
    createReadStream(path)
      .on('error', rej)
      .on('data', (c) => hash.update(c))
      .on('end', () => res(hash.digest('base64')));
  });
}

/** `files:` entries (url, sha512, size) of an electron-builder manifest. */
function manifestFiles(text) {
  const files = [];
  let cur = null;
  let inFiles = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^files:\s*$/.test(line)) { inFiles = true; continue; }
    if (inFiles && /^\S/.test(line)) inFiles = false;
    if (!inFiles) continue;
    const item = /^\s*-\s+url:\s*(\S+)\s*$/.exec(line);
    if (item) { if (cur) files.push(cur); cur = { url: item[1].replace(/^["']|["']$/g, '') }; continue; }
    const field = /^\s+(sha512|size):\s*(\S+)\s*$/.exec(line);
    if (field && cur) cur[field[1]] = field[2].replace(/^["']|["']$/g, '');
  }
  if (cur) files.push(cur);
  return files;
}

// Before anything goes up: every file a local manifest lists must exist here
// and hash to the sha512 it declares, otherwise the manifest would advertise
// bytes that are not the ones being published (stale or mixed builds).
for (const name of MANIFESTS) {
  if (!toUpload.some((a) => a.name === name)) continue;
  const text = readFileSync(resolve(releaseDir, name), 'utf8');
  for (const f of manifestFiles(text)) {
    const local = resolve(releaseDir, f.url);
    if (!existsSync(local)) {
      console.error(`[upload] ${name} lists ${f.url} but it is not in release/`);
      process.exit(1);
    }
    if (f.sha512 && (await sha512Base64(local)) !== f.sha512) {
      console.error(`[upload] ${f.url} does not match the sha512 in ${name}: stale build? rebuild first.`);
      process.exit(1);
    }
  }
}

// Binaries first, then (signature, manifest): a client never sees a manifest
// whose files are not yet in the bucket.
const binaries = toUpload.filter((a) => !MANIFESTS.includes(a.name));
const manifestUploads = toUpload.filter((a) => MANIFESTS.includes(a.name));

for (const { name, contentType } of binaries) {
  const filePath = resolve(releaseDir, name);
  const size = statSync(filePath).size;
  console.log(`[upload] ${name} (${fmtMB(size)}) …`);

  const body = readFileSync(filePath);
  const { url, existed } = await putObject(name, body, contentType);
  if (existed) {
    // Immutable key already in the bucket: fine if it is the same file (re-run
    // after a partial publish), fatal if not (the CDN may serve it for a year).
    const head = await fetch(url, { method: 'HEAD' });
    const remote = Number(head.headers.get('content-length'));
    if (!head.ok || remote !== size) {
      console.error(`[upload] ${name} already exists with a different size (${remote} vs ${size} bytes).`);
      console.error('[upload] versioned artifacts are immutable; bump the version instead of overwriting.');
      process.exit(1);
    }
    console.log('[upload] ↪ already published with the same size, skipped');
  } else {
    console.log(`[upload] ↪ ${url}`);
  }
}

for (const { name, contentType } of manifestUploads) {
  const body = readFileSync(resolve(releaseDir, name));
  if (signingKey) {
    const sigName = `${name}.sig`;
    await putObject(sigName, Buffer.from(`${signManifest(body)}\n`), 'text/plain');
    console.log(`[sign] ${sigName} uploaded`);
  } else {
    console.warn(`[sign] WARNING: ${name} published WITHOUT a signature (--allow-unsigned)`);
  }
  const { url } = await putObject(name, body, contentType);
  console.log(`[upload] ${name} ↪ ${url}`);
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
/** Manifests that are not published yet (left out of the summary). */
const skipped = new Set();

async function verifyManifest(name) {
  const problems = [];
  // Cache-buster: electron-updater appends one too, so this mirrors what
  // a real client fetches rather than whatever an edge cache holds.
  const url = `${publicBase}/${name}?noCache=${Date.now()}`;
  const res = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) {
    if (res.status === 404 && verifyOnly && name === 'latest-linux.yml') {
      console.log('[verify] no Linux build published yet, skipping');
      skipped.add(name);
      return [];
    }
    return [`${name}: HTTP ${res.status} ${res.statusText}`];
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  const body = bytes.toString('utf8');

  const declared = body.match(/^version:\s*['"]?([^'"\s]+)/m)?.[1];
  if (declared !== version) {
    problems.push(`${name}: advertises version ${declared ?? '(none)'}, expected ${version}`);
  }

  // Detached signature: checked against the key embedded in the app, so this
  // proves what installed clients will conclude, not just that a file exists.
  const publicKey = embeddedPublicKey();
  const sigRes = await fetch(`${url.replace(name, `${name}.sig`)}`, {
    headers: { 'cache-control': 'no-cache' },
  });
  if (publicKey && sigRes.ok) {
    const spki = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKey, 'base64')]),
      format: 'der',
      type: 'spki',
    });
    const sig = Buffer.from((await sigRes.text()).trim(), 'base64');
    if (!verify(null, bytes, spki, sig)) {
      problems.push(`${name}: ${name}.sig does NOT verify against the embedded public key`);
    }
  } else if (publicKey && !allowUnsigned) {
    problems.push(`${name}: no ${name}.sig published (HTTP ${sigRes.status})`);
  } else if (!sigRes.ok) {
    console.warn(`[verify] WARNING: ${name} has no signature`);
  }

  const files = manifestFiles(body);
  if (files.length === 0) {
    problems.push(`${name}: lists no files`);
  }
  for (const file of files) {
    const fileUrl = /^https?:/.test(file.url) ? file.url : `${publicBase}/${file.url}`;
    const head = await fetch(fileUrl, { method: 'HEAD' });
    if (!head.ok) {
      problems.push(`${name}: references ${file.url} — HTTP ${head.status}`);
      continue;
    }
    const remote = Number(head.headers.get('content-length'));
    if (file.size && remote && remote !== Number(file.size)) {
      problems.push(`${name}: ${file.url} is ${remote} bytes on the CDN, manifest says ${file.size}`);
    }
  }
  return problems;
}

// Windows manifest by default. Mac / Linux manifests whenever they were part
// of this publish, or always in --verify-only mode (a Windows-only local ship
// deliberately leaves the other platforms' manifests behind).
const manifests = macOnly || linuxOnly ? [] : ['latest.yml'];
if (verifyOnly || macOnly || toUpload.some((a) => a.name === 'latest-mac.yml')) {
  manifests.push('latest-mac.yml');
}
if (verifyOnly || linuxOnly || toUpload.some((a) => a.name === 'latest-linux.yml')) {
  manifests.push('latest-linux.yml');
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

const served = manifests.filter((m) => !skipped.has(m));
console.log('');
console.log(`[verify] feed serves ${version} — ${served.join(', ')} healthy`);
console.log('[upload] done. site download links:');
if (served.includes('latest.yml')) {
  console.log(`  ${publicBase}/Plasma-Setup-${version}-x64.exe`);
  console.log(`  ${publicBase}/Plasma-Portable-${version}-x64.exe`);
  console.log(`  ${publicBase}/latest.yml          ← Win auto-update`);
}
if (served.includes('latest-mac.yml')) {
  console.log(`  ${publicBase}/Plasma-${version}-arm64.dmg`);
  console.log(`  ${publicBase}/latest-mac.yml    ← Mac auto-update`);
}
if (served.includes('latest-linux.yml')) {
  console.log(`  ${publicBase}/Plasma-${version}-x86_64.AppImage`);
  console.log(`  ${publicBase}/latest-linux.yml  ← Linux auto-update`);
}
console.log('[upload] the site reads these manifests at build time (site/lib/version.ts); redeploy it.');
