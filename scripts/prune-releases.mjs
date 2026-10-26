#!/usr/bin/env node
/**
 * Deletes old release artifacts from the Cloudflare R2 bucket, keeping only
 * the versions the live feed serves (latest.yml / latest-mac.yml /
 * latest-linux.yml). Manifests, their .sig files and any key that is not a
 * versioned `Plasma-<version>…` artifact are never touched.
 *
 * Dry run by default: lists what would go. Pass --delete to remove it.
 *
 *   node scripts/prune-releases.mjs            # dry run
 *   node scripts/prune-releases.mjs --delete
 *
 * Needs R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY (env or .env.local), like
 * upload-release.mjs. Same optional R2_ACCOUNT_ID / R2_BUCKET /
 * R2_PUBLIC_BASE_URL / R2_ENDPOINT overrides.
 */

import { createHash, createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Same tiny .env.local loader as upload-release.mjs (shell wins over file).
const envPath = resolve(root, '.env.local');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const doDelete = process.argv.includes('--delete');
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
if (!accessKeyId || !secretAccessKey) {
  console.error('[prune] R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY not set (env or .env.local)');
  process.exit(1);
}
const accountId = process.env.R2_ACCOUNT_ID || '945bc8f64778fda12f098a60e0ed122f';
const bucket = process.env.R2_BUCKET || 'plasma';
const publicBase = (
  process.env.R2_PUBLIC_BASE_URL || 'https://pub-05a2064511bc41689f299b542b07b67f.r2.dev'
).replace(/\/$/, '');
const endpoint = (
  process.env.R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`
).replace(/\/$/, '');

const MANIFESTS = ['latest.yml', 'latest-mac.yml', 'latest-linux.yml'];

// ── What the feed serves now ─────────────────────────────────────────
/** Versions the live manifests advertise; any fetch problem aborts. */
async function liveVersions() {
  const versions = new Set();
  for (const name of MANIFESTS) {
    const res = await fetch(`${publicBase}/${name}?noCache=${Date.now()}`);
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const v = /^version:\s*['"]?([0-9][^'"\s]*)/m.exec(await res.text())?.[1];
    if (!v) throw new Error(`${name}: no version line`);
    console.log(`[prune] ${name} serves ${v}`);
    versions.add(v);
  }
  if (versions.size === 0) throw new Error('no manifest found on the feed; refusing to prune');
  return versions;
}

// ── S3 API (SigV4, no deps) ──────────────────────────────────────────
const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
const enc = (s) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/**
 * @param {'GET' | 'DELETE'} method
 * @param {string} key object key, or '' for the bucket itself
 * @param {Record<string, string>} [query]
 */
async function s3(method, key, query = {}) {
  const host = new URL(endpoint).host;
  const path = `/${bucket}${key ? `/${key.split('/').map(enc).join('/')}` : ''}`;
  const qs = Object.keys(query)
    .sort()
    .map((k) => `${enc(k)}=${enc(query[k])}`)
    .join('&');
  const amz = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amz.slice(0, 8);
  const payloadHash = sha256Hex('');
  const headers = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amz };
  const names = Object.keys(headers).sort();
  const canonical = [
    method,
    path,
    qs,
    names.map((n) => `${n}:${headers[n]}\n`).join(''),
    names.join(';'),
    payloadHash,
  ].join('\n');
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amz, scope, sha256Hex(canonical)].join('\n');
  const kSigning = hmac(
    hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), 'auto'), 's3'),
    'aws4_request',
  );
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
  const res = await fetch(`${endpoint}${path}${qs ? `?${qs}` : ''}`, {
    method,
    headers: {
      ...headers,
      Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return text;
}

const unxml = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** Every object in the bucket: { key, size }. */
async function listAll() {
  const out = [];
  let token;
  do {
    const xml = await s3('GET', '', {
      'list-type': '2',
      ...(token ? { 'continuation-token': token } : {}),
    });
    for (const [, body] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = unxml(/<Key>([\s\S]*?)<\/Key>/.exec(body)?.[1] ?? '');
      const size = Number(/<Size>(\d+)<\/Size>/.exec(body)?.[1] ?? 0);
      if (key) out.push({ key, size });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
      ? unxml(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] ?? '')
      : undefined;
  } while (token);
  return out;
}

// ── Prune ────────────────────────────────────────────────────────────
/** `Plasma-3.2.7-arm64.dmg`, `Plasma-Setup-3.2.7-x64.exe.blockmap` → `3.2.7`. */
const artifactVersion = (key) =>
  /^Plasma-(?:[A-Za-z]+-)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-/.exec(key)?.[1];

const keep = await liveVersions();
const objects = await listAll();
const fmtMB = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`;

const old = [];
const other = [];
for (const o of objects) {
  const v = artifactVersion(o.key);
  if (v == null) other.push(o);
  else if (!keep.has(v)) old.push(o);
}

console.log(
  `[prune] ${objects.length} objects in ${bucket}; keeping version(s) ${[...keep].join(', ')}`,
);
if (other.length > 0) {
  console.log('[prune] left alone (not a versioned artifact):');
  for (const o of other) console.log(`  = ${o.key}`);
}
if (old.length === 0) {
  console.log('[prune] nothing to delete');
  process.exit(0);
}
const total = old.reduce((n, o) => n + o.size, 0);
console.log(
  `[prune] ${doDelete ? 'deleting' : 'would delete'} ${old.length} objects (${fmtMB(total)}):`,
);
for (const o of old) {
  console.log(`  - ${o.key} (${fmtMB(o.size)})`);
  if (doDelete) await s3('DELETE', o.key);
}
if (!doDelete) console.log('[prune] dry run; pass --delete to remove them');
else console.log('[prune] done');
