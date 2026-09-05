#!/usr/bin/env node
/**
 * Cross-platform release script.
 *
 * Usage:
 *   pnpm run release:patch   # 0.0.2 → 0.0.3
 *   pnpm run release:minor   # 0.0.2 → 0.1.0
 *   pnpm run release:major   # 0.0.2 → 1.0.0
 *
 * Does:
 *   1. Bumps package.json version (in-place, preserves formatting)
 *   2. Patches site/lib/version.ts (VERSION + asset URLs)
 *   3. Stages both files with git
 *
 * Does NOT:
 *   - Commit (you write the message) — see scripts/ship.mjs for one-shot
 *   - Tag (you tag when ready)
 *   - Push
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const kind = process.argv[2];
if (!['patch', 'minor', 'major'].includes(kind)) {
  console.error('usage: node scripts/release.mjs <patch|minor|major>');
  process.exit(1);
}

// ── 1. Bump package.json ──────────────────────────────────────────────
const pkgPath = resolve(root, 'package.json');
const pkgRaw = readFileSync(pkgPath, 'utf8');
const pkg = JSON.parse(pkgRaw);

const [maj, min, pat] = pkg.version.split('.').map(Number);
const next =
  kind === 'major' ? `${maj + 1}.0.0` :
  kind === 'minor' ? `${maj}.${min + 1}.0` :
                     `${maj}.${min}.${pat + 1}`;

const updatedPkg = pkgRaw.replace(
  /"version":\s*"[^"]+"/,
  `"version": "${next}"`,
);
writeFileSync(pkgPath, updatedPkg);
console.log(`[release] package.json ${pkg.version} → ${next}`);

// ── 2. Sync site/lib/version.ts ───────────────────────────────────────
const sitePath = resolve(root, 'site/lib/version.ts');
const siteBefore = readFileSync(sitePath, 'utf8');
const siteAfter = siteBefore
  .replace(/(export const VERSION\s*=\s*')([^']+)(')/, `$1${next}$3`)
  .replace(/Plasma-Setup-\d+\.\d+\.\d+-x64\.exe/g, `Plasma-Setup-${next}-x64.exe`)
  .replace(/Plasma-Portable-\d+\.\d+\.\d+-x64\.exe/g, `Plasma-Portable-${next}-x64.exe`)
  // macOS DMGs
  .replace(/Plasma-\d+\.\d+\.\d+-arm64\.dmg/g, `Plasma-${next}-arm64.dmg`)
  .replace(/Plasma-\d+\.\d+\.\d+-x64\.dmg/g, `Plasma-${next}-x64.dmg`);

if (siteBefore !== siteAfter) {
  writeFileSync(sitePath, siteAfter);
  console.log(`[release] site/lib/version.ts → ${next}`);
} else {
  console.log(`[release] site/lib/version.ts already at ${next}`);
}

// ── 3. Stage ──────────────────────────────────────────────────────────
const add = spawnSync('git', ['add', 'package.json', 'site/lib/version.ts'], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
});
if (add.status !== 0) {
  console.error('[release] git add failed');
  process.exit(add.status ?? 1);
}

console.log('');
console.log(`[release] done. next steps:`);
console.log(`  git commit -m "v${next}"`);
console.log(`  git tag v${next}`);
console.log(`  git push && git push --tags`);
console.log('');
console.log(`or one-shot:  pnpm run ship:patch`);
