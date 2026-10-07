import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createZip, dosDateTime, safeZipName } from './zip-writer';

/** A reader for exactly what the writer produces: the central directory, then each entry. */
function readZip(zip: Buffer): Map<string, Buffer> {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const csize = zip.readUInt32LE(at + 20);
    const usize = zip.readUInt32LE(at + 24);
    const nameLen = zip.readUInt16LE(at + 28);
    const extraLen = zip.readUInt16LE(at + 30);
    const commentLen = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    expect(zip.readUInt32LE(local)).toBe(0x04034b50);
    const lNameLen = zip.readUInt16LE(local + 26);
    const lExtraLen = zip.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const body = zip.subarray(start, start + csize);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    expect(data.length).toBe(usize);
    expect(crc32(data)).toBe(crc);
    out.set(name, data);
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe('createZip', () => {
  it('round-trips text files, compressed when that helps and stored when it does not', () => {
    const big = Buffer.from('plasma support bundle line\n'.repeat(500));
    const tiny = Buffer.from('x');
    const zip = createZip([
      { name: 'logs/main.log', data: big },
      { name: 'README.txt', data: tiny },
      { name: 'empty.txt', data: Buffer.alloc(0) },
    ]);
    const files = readZip(zip);
    expect([...files.keys()]).toEqual(['logs/main.log', 'README.txt', 'empty.txt']);
    expect(files.get('logs/main.log')?.equals(big)).toBe(true);
    expect(files.get('README.txt')?.toString()).toBe('x');
    expect(files.get('empty.txt')?.length).toBe(0);
    // The log compresses far below its size.
    expect(zip.length).toBeLessThan(big.length / 4);
  });

  it('keeps non-ASCII names and content', () => {
    const zip = createZip([{ name: 'données/ログ.txt', data: Buffer.from('héllo 日本語 🎉') }]);
    const files = readZip(zip);
    expect(files.get('données/ログ.txt')?.toString()).toBe('héllo 日本語 🎉');
  });

  it('refuses duplicate names and names that climb out of the folder', () => {
    expect(() =>
      createZip([
        { name: 'a.txt', data: Buffer.from('1') },
        { name: 'a.txt', data: Buffer.from('2') },
      ]),
    ).toThrow(/duplicate/);
    expect(safeZipName('../../etc/passwd')).toBe('etc/passwd');
    expect(safeZipName('a\\b\\c.txt')).toBe('a/b/c.txt');
    expect(safeZipName('/abs/path.txt')).toBe('abs/path.txt');
    expect(() => safeZipName('..')).toThrow(/invalid/);
    expect(() => safeZipName('')).toThrow(/invalid/);
  });

  it('writes DOS dates the way the format has them', () => {
    const { date, time } = dosDateTime(new Date(2026, 9, 7, 13, 45, 30));
    expect(date).toBe(((2026 - 1980) << 9) | (10 << 5) | 7);
    expect(time).toBe((13 << 11) | (45 << 5) | 15);
    expect(dosDateTime(new Date(1975, 0, 1)).date >> 9).toBe(0);
  });

  it('makes an archive the system unzip tool accepts (when it exists)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plasma-zip-'));
    try {
      const file = join(dir, 'bundle.zip');
      writeFileSync(
        file,
        createZip([
          { name: 'README.txt', data: Buffer.from('hello\n') },
          { name: 'logs/main.log', data: Buffer.from('line\n'.repeat(200)) },
        ]),
      );
      let out: string;
      try {
        out = execFileSync('unzip', ['-t', file], { encoding: 'utf8' });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // no unzip here
        throw err;
      }
      expect(out).toMatch(/No errors detected/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
