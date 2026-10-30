import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ID_FILE = 'telemetry-id';
const VALID_ID = /^[0-9a-f]{64}$/;

/**
 * The install's anonymous id: the hash of a random value kept in userData. It
 * says nothing about the person or the machine, and no account or other app's
 * credentials are read to make it. Null when it cannot be saved: an id that
 * changes each launch would count every launch as a new install.
 */
export function readOrCreateInstallId(userDataDir: string): string | null {
  const path = join(userDataDir, ID_FILE);
  try {
    const saved = readFileSync(path, 'utf8').trim();
    if (VALID_ID.test(saved)) return saved;
  } catch {
    // Not created yet, or unreadable: the write below decides.
  }
  try {
    const id = createHash('sha256').update(randomUUID()).digest('hex');
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, id, 'utf8');
    renameSync(temp, path);
    return id;
  } catch {
    return null;
  }
}
