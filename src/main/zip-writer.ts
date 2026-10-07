import { crc32, deflateRawSync } from 'node:zlib';

/**
 * A small ZIP writer: Electron ships no zip library and a support bundle needs
 * nothing beyond a handful of text files, so this writes the format directly
 * (PKZIP "deflate" entries, UTF-8 names, no zip64, no encryption).
 *
 * Limits are those of the plain format: 65,535 entries and 4 GiB per file and
 * per archive. A bundle is a few hundred kilobytes.
 */

export interface ZipEntry {
  /** Path inside the archive, `/` separated. */
  name: string;
  data: Buffer;
  /** Defaults to now. Stored in DOS time, so the resolution is two seconds. */
  modified?: Date;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
/** UTF-8 file names (general purpose bit 11). */
const FLAG_UTF8 = 0x0800;
const VERSION_NEEDED = 20;
const VERSION_MADE_BY = (3 << 8) | 20; // Unix, 2.0

/** MS-DOS date and time as the format stores them. */
export function dosDateTime(d: Date): { date: number; time: number } {
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
  };
}

/** A name that cannot climb out of the folder it is extracted into. */
export function safeZipName(name: string): string {
  const parts = name
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p && p !== '.' && p !== '..');
  if (parts.length === 0) throw new Error(`invalid zip entry name: ${JSON.stringify(name)}`);
  return parts.join('/');
}

export function createZip(entries: readonly ZipEntry[]): Buffer {
  if (entries.length > 0xffff) throw new Error('too many files for a zip archive');
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const seen = new Set<string>();

  for (const entry of entries) {
    const name = safeZipName(entry.name);
    if (seen.has(name)) throw new Error(`duplicate zip entry: ${name}`);
    seen.add(name);
    const nameBytes = Buffer.from(name, 'utf8');
    const raw = entry.data;
    // Stored when deflating does not help (tiny or already compressed files).
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);
    const { date, time } = dosDateTime(entry.modified ?? new Date());
    if (raw.length > 0xffffffff || body.length > 0xffffffff)
      throw new Error('file too large for zip');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBytes, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(SIG_CENTRAL, 0);
    dir.writeUInt16LE(VERSION_MADE_BY, 4);
    dir.writeUInt16LE(VERSION_NEEDED, 6);
    dir.writeUInt16LE(FLAG_UTF8, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt16LE(0, 30); // extra
    dir.writeUInt16LE(0, 32); // comment
    dir.writeUInt16LE(0, 34); // disk
    dir.writeUInt16LE(0, 36); // internal attributes
    dir.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external: -rw-r--r--
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBytes);

    offset += local.length + nameBytes.length + body.length;
  }

  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_END, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  if (offset + centralBytes.length > 0xffffffff) throw new Error('archive too large for zip');
  return Buffer.concat([...chunks, centralBytes, end]);
}
