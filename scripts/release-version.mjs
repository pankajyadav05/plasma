#!/usr/bin/env node
/**
 * Picks the version for a release from the live update feed (see
 * lib/next-version.mjs for the rule) and prints it.
 *
 *   node scripts/release-version.mjs --platforms=all [--bump=patch|minor|major]
 *   node scripts/release-version.mjs --platforms=linux --check=3.1.5
 *
 * --check exits 1 when that exact version is already published (or tagged)
 * for the chosen platforms: a run from a version tag cannot pick another one.
 * Reads only public URLs; needs git tags fetched for the tag check.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MANIFEST,
  PLATFORM_SETS,
  installerName,
  nextReleaseVersion,
} from './lib/next-version.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FEED = process.env.R2_PUBLIC_BASE_URL || 'https://pub-05a2064511bc41689f299b542b07b67f.r2.dev';
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

const platforms = PLATFORM_SETS[arg('platforms') ?? 'all'];
if (!platforms) {
  console.error(`unknown --platforms; use one of: ${Object.keys(PLATFORM_SETS).join(', ')}`);
  process.exit(2);
}
const kind = arg('bump') ?? 'patch';
const current = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;

async function exists(name) {
  const res = await fetch(`${FEED}/${name}?noCache=${Date.now()}`, { method: 'HEAD' });
  return res.ok;
}

const rev = (ref) => {
  const r = spawnSync('git', ['rev-parse', '-q', '--verify', `${ref}^{commit}`], { cwd: root });
  return r.status === 0 ? r.stdout.toString().trim() : null;
};
const head = rev('HEAD');
/** A tag is taken unless it marks the very commit being released. */
function tagged(version) {
  const at = rev(`refs/tags/v${version}`);
  return at !== null && at !== head;
}

async function publishedVersions() {
  const out = [];
  for (const os of platforms) {
    const res = await fetch(`${FEED}/${MANIFEST[os]}?noCache=${Date.now()}`);
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`${MANIFEST[os]}: HTTP ${res.status}`);
    const m = /^version:\s*['"]?([0-9.]+)/m.exec(await res.text());
    if (m) out.push(m[1]);
  }
  return out;
}

// Installers of a version, checked once per candidate.
const takenCache = new Map();
async function filesTaken(version) {
  if (!takenCache.has(version)) {
    const hits = await Promise.all(platforms.map((os) => exists(installerName(os, version))));
    takenCache.set(version, hits.some(Boolean));
  }
  return takenCache.get(version);
}

const check = arg('check');
if (check) {
  const files = await filesTaken(check);
  if (files) {
    console.error(`${check} is already published for some of: ${platforms.join(', ')}. Release from main to get the next free version, or leave those platforms out.`);
    process.exit(1);
  }
  console.log(check);
  process.exit(0);
}

// The rule is synchronous; resolve the network part first for a bounded range.
const published = await publishedVersions();
const probe = new Map();
let v = nextReleaseVersion({ current, published, kind, taken: () => false });
for (let i = 0; i < 100; i++) {
  const t = tagged(v) || (await filesTaken(v));
  probe.set(v, t);
  if (!t) break;
  v = nextReleaseVersion({ current: v, published: [v], kind: 'patch', taken: () => false });
}
const next = nextReleaseVersion({ current, published, kind, taken: (x) => probe.get(x) === true });
console.error(`[version] package.json ${current}; published for ${platforms.join(', ')}: ${published.join(', ') || 'none'} → ${next}`);
console.log(next);
