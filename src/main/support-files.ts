import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import type { SupportBundleFile } from '@shared/support-bundle';
import { createZip } from './zip-writer';

/** Helpers of the support bundle that touch files but not Electron, so they are tested alone. */

/** Newest bytes of a text file: logs can be megabytes, the bundle wants the end. */
export function readTail(path: string, maxBytes = 2 * 1024 * 1024): string {
  if (!existsSync(path)) return '';
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    // The first line of a tail is usually cut in half.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } catch (err) {
    return `(could not read ${path}: ${err instanceof Error ? err.message : String(err)})`;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function stampForFileName(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function zipOf(files: readonly SupportBundleFile[], when = new Date()): Buffer {
  return createZip(
    files.map((f) => ({ name: f.name, data: Buffer.from(f.text, 'utf8'), modified: when })),
  );
}
