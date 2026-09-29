/**
 * S4: main and the worker must agree on which response kind answers each
 * OpenSearch request kind (a mismatch is how R1 shipped for Redis). Reads
 * both sources and checks every `callWorker({ kind: 'osX' … }, 'Y')` in
 * main against the `send({ kind: 'Y' })` of the worker's `case 'osX'`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const mainSrc = readFileSync(join(root, 'main/index.ts'), 'utf8');
const workerSrc = readFileSync(join(root, 'workers/index.ts'), 'utf8');

/** Expected response kind per OpenSearch request kind. */
const EXPECTED: Record<string, string> = {
  osOverview: 'osOverview',
  osMapping: 'osMapping',
  osSearch: 'osSearch',
  osSql: 'osSql',
  osAliases: 'osAliases',
  osIlm: 'osIlm',
  osCreateIndex: 'osCreateIndex',
  osDeleteIndex: 'osDeleteIndex',
  osFieldStats: 'osFieldStats',
  osRequest: 'osResponse',
  osCancel: 'cancelled',
};

function workerCase(kind: string): string {
  const start = workerSrc.indexOf(`case '${kind}':`);
  expect(start, `worker handles ${kind}`).toBeGreaterThan(-1);
  const next = workerSrc.indexOf('case ', start + 6);
  return workerSrc.slice(start, next < 0 ? undefined : next);
}

describe('OpenSearch request → response kinds (S4)', () => {
  it.each(Object.entries(EXPECTED))('worker answers %s with %s', (req, res) => {
    expect(workerCase(req)).toMatch(new RegExp(`send\\(\\{\\s*kind: '${res}'`));
  });

  it.each(Object.entries(EXPECTED))('main awaits %s as %s', (req, res) => {
    const re = new RegExp(
      `callWorker\\(\\s*\\{\\s*kind: '${req}'[\\s\\S]*?\\},\\s*'([A-Za-z]+)'`,
      'g',
    );
    const found = [...mainSrc.matchAll(re)].map((m) => m[1]);
    expect(found.length, `main calls ${req}`).toBeGreaterThan(0);
    for (const kind of found) expect(kind).toBe(res);
  });
});
