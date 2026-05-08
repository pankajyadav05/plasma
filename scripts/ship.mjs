#!/usr/bin/env node
/**
 * One-shot release: bump → commit → tag → push.
 *
 * Usage:
 *   pnpm run ship:patch
 *   pnpm run ship:minor
 *   pnpm run ship:major
 *
 * Optional flags:
 *   --no-tag      skip git tag
 *   --no-push     skip git push
 *   --remote=<r>  push target (default: origin)
 *   --dry         print actions, run none
 *
 * Sequence:
 *   1. node scripts/release.mjs <kind>      (bumps + stages)
 *   2. git commit -m "v<next>"
 *   3. git tag v<next>                       (unless --no-tag)
 *   4. git push <remote> HEAD                (unless --no-push)
 *   5. git push <remote> --tags              (unless --no-tag or --no-push)
 *
 * Aborts if working tree has staged or unstaged changes other than
 * package.json — release.mjs already touches that file. This prevents
 * accidentally committing in-progress work alongside the version bump.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const args = process.argv.slice(2);
const kind = args.find((a) => ['patch', 'minor', 'major'].includes(a));
if (!kind) {
  console.error('usage: node scripts/ship.mjs <patch|minor|major> [--no-tag] [--no-push] [--remote=origin] [--dry]');
  process.exit(1);
}
const noTag = args.includes('--no-tag');
const noPush = args.includes('--no-push');
const dry = args.includes('--dry');
const remoteArg = args.find((a) => a.startsWith('--remote='));
const remote = remoteArg ? remoteArg.split('=')[1] : 'origin';

function run(cmd, argv, { check = true } = {}) {
  console.log(`$ ${cmd} ${argv.join(' ')}`);
  if (dry) return { status: 0, stdout: '', stderr: '' };
  const r = spawnSync(cmd, argv, { cwd: root, stdio: 'inherit', shell: true });
  if (check && r.status !== 0) {
    console.error(`[ship] '${cmd} ${argv.join(' ')}' failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
  return r;
}

function capture(cmd, argv) {
  const r = spawnSync(cmd, argv, { cwd: root, encoding: 'utf8', shell: true });
  if (r.status !== 0) {
    console.error(`[ship] '${cmd} ${argv.join(' ')}' failed:`);
    if (r.stderr) console.error(r.stderr);
    process.exit(r.status ?? 1);
  }
  return r.stdout;
}

// ── Pre-flight: clean tree (allow only package.json modified) ─────────
const status = capture('git', ['status', '--porcelain']);
const dirty = status
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .filter((l) => {
    const path = l.slice(3);
    return path !== 'package.json' && path !== 'site/lib/version.ts';
  });
if (dirty.length) {
  console.error('[ship] aborting — working tree has unrelated changes:');
  for (const l of dirty) console.error(`  ${l}`);
  console.error('       commit or stash them first.');
  process.exit(1);
}

// ── 1. Bump + stage via release.mjs ───────────────────────────────────
run('node', ['scripts/release.mjs', kind]);

// ── Read bumped version (release.mjs already wrote package.json) ──────
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const tag = `v${pkg.version}`;

// ── 2. Commit ─────────────────────────────────────────────────────────
run('git', ['commit', '-m', `"${tag}"`]);

// ── 3. Tag ────────────────────────────────────────────────────────────
if (!noTag) {
  run('git', ['tag', tag]);
}

// ── 4/5. Push ─────────────────────────────────────────────────────────
if (!noPush) {
  run('git', ['push', remote, 'HEAD']);
  if (!noTag) {
    run('git', ['push', remote, '--tags']);
  }
}

console.log('');
console.log(`[ship] shipped ${tag}`);
if (noPush) console.log('[ship] push skipped — push manually when ready');
