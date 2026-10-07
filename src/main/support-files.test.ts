import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { readTail, stampForFileName, zipOf } from './support-files';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'plasma-support-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('readTail', () => {
  it('returns a whole small file', () => {
    const file = join(tmp(), 'a.log');
    writeFileSync(file, 'one\ntwo\n');
    expect(readTail(file)).toBe('one\ntwo\n');
  });

  it('returns only the end of a big file and drops the line it cut in half', () => {
    const file = join(tmp(), 'big.log');
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${String(i).padStart(5, '0')}`);
    writeFileSync(file, `${lines.join('\n')}\n`);
    const tail = readTail(file, 1000);
    const got = tail.trim().split('\n');
    expect(got.at(-1)).toBe('line 04999');
    expect(got[0]).toMatch(/^line \d{5}$/);
    expect(tail.length).toBeLessThanOrEqual(1000);
  });

  it('is empty for a file that is not there, and says so for one it cannot read', () => {
    expect(readTail(join(tmp(), 'missing.log'))).toBe('');
    expect(readTail(tmp())).toMatch(/could not read/);
  });
});

describe('zipOf', () => {
  it('writes every file under its name with its exact text', () => {
    const zip = zipOf([
      { name: 'README.txt', description: 'd', text: 'hello\n', bytes: 6 },
      { name: 'logs/main.log', description: 'd', text: 'héllo 🎉\n'.repeat(100), bytes: 0 },
    ]);
    // Local header of the first entry: stored (tiny), name, then the text.
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    const nameLen = zip.readUInt16LE(26);
    expect(zip.subarray(30, 30 + nameLen).toString()).toBe('README.txt');
    expect(zip.subarray(30 + nameLen, 30 + nameLen + 6).toString()).toBe('hello\n');
    // The second is deflated and inflates back to what went in.
    const second = 30 + nameLen + 6;
    const csize = zip.readUInt32LE(second + 18);
    const n2 = zip.readUInt16LE(second + 26);
    const body = zip.subarray(second + 30 + n2, second + 30 + n2 + csize);
    expect(inflateRawSync(body).toString()).toBe('héllo 🎉\n'.repeat(100));
  });
});

describe('stampForFileName', () => {
  it('is sortable and safe in a file name', () => {
    expect(stampForFileName(new Date(2026, 9, 7, 9, 5))).toBe('20261007-0905');
  });
});
