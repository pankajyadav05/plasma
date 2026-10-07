import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * The bearer token and the "where am I listening" file, both under userData.
 * The stdio bridge reads them, so they are plain files, not the vault. The
 * token file is owner-only (0600 where the OS has modes).
 */

export const TOKEN_FILE = 'mcp-token';
export const PORT_FILE = 'mcp.json';

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

function writePrivate(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Windows: no modes
  }
  renameSync(tmp, path);
}

/** The saved token; a new one is written when there is none (or it is unusable). */
export function loadOrCreateToken(dir: string): string {
  const path = join(dir, TOKEN_FILE);
  try {
    const t = readFileSync(path, 'utf8').trim();
    if (/^[A-Za-z0-9_-]{43}$/.test(t)) {
      try {
        chmodSync(path, 0o600);
      } catch {}
      return t;
    }
  } catch {
    // first enable
  }
  return regenerateToken(dir);
}

export function regenerateToken(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const token = newToken();
  writePrivate(join(dir, TOKEN_FILE), `${token}\n`);
  return token;
}

export function writePortFile(dir: string, port: number): void {
  mkdirSync(dir, { recursive: true });
  writePrivate(join(dir, PORT_FILE), JSON.stringify({ port, pid: process.pid }));
}

export function removePortFile(dir: string): void {
  const path = join(dir, PORT_FILE);
  if (existsSync(path)) rmSync(path, { force: true });
}
