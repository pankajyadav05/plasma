import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadOrCreateToken,
  newToken,
  regenerateToken,
  removePortFile,
  writePortFile,
} from './token-store';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'plasma-mcp-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('token store', () => {
  it('makes 32 random bytes as base64url', () => {
    expect(newToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken()).not.toBe(newToken());
  });
  it('creates once, then keeps the token', () => {
    const d = tmp();
    const a = loadOrCreateToken(d);
    expect(loadOrCreateToken(d)).toBe(a);
    expect(readFileSync(join(d, 'mcp-token'), 'utf8').trim()).toBe(a);
  });
  it.skipIf(process.platform === 'win32')('is owner-only (0600)', () => {
    const d = tmp();
    loadOrCreateToken(d);
    expect(statSync(join(d, 'mcp-token')).mode & 0o777).toBe(0o600);
  });
  it('replaces a damaged file and regenerates on request', () => {
    const d = tmp();
    writeFileSync(join(d, 'mcp-token'), 'short');
    const a = loadOrCreateToken(d);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const b = regenerateToken(d);
    expect(b).not.toBe(a);
    expect(loadOrCreateToken(d)).toBe(b);
  });
  it('writes and removes the port file', () => {
    const d = tmp();
    writePortFile(d, 47321);
    expect(JSON.parse(readFileSync(join(d, 'mcp.json'), 'utf8')).port).toBe(47321);
    removePortFile(d);
    expect(() => readFileSync(join(d, 'mcp.json'))).toThrow();
    removePortFile(d);
  });
});
