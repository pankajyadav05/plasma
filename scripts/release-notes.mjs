#!/usr/bin/env node
/**
 * Writes the GitHub release notes for a version (see lib/release-notes.mjs):
 * every user-facing commit since the previous version tag.
 *
 *   node scripts/release-notes.mjs 3.2.2 [--out=release-notes.md]
 *
 * Needs full history and tags (actions/checkout with fetch-depth: 0). The
 * version's own tag is used when it exists, otherwise HEAD.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseNotes } from './lib/release-notes.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2]?.replace(/^v/, '');
const out = process.argv.find((a) => a.startsWith('--out='))?.slice('--out='.length);
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('usage: node scripts/release-notes.mjs <version> [--out=file]');
  process.exit(2);
}

function git(...args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

const end = git('rev-parse', '-q', '--verify', `refs/tags/v${version}^{commit}`)
  ? `v${version}`
  : 'HEAD';
// The nearest older version tag reachable from this release.
const previous = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', `${end}^`);
const range = previous ? `${previous}..${end}` : end;
const log = git('log', '--no-merges', '--format=%s', range);
if (log === null) {
  console.error(`git log ${range} failed (are tags fetched?)`);
  process.exit(1);
}

const body = releaseNotes({ version, previous, subjects: log ? log.split('\n') : [] });
if (out) writeFileSync(resolve(out), body);
else process.stdout.write(body);
