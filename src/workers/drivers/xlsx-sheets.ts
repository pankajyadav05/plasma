import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

/**
 * Sheet names of an .xlsx workbook, read straight from the zip: the central
 * directory locates `xl/workbook.xml`, which is inflated (size-capped) and
 * scanned for `<sheet name="…">`. DuckDB's `read_xlsx` reads one sheet per
 * call and has no way to list them, so this is how every sheet becomes a
 * view. Hidden sheets are skipped unless every sheet is hidden.
 */

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
/** workbook.xml is a sheet index; anything this large is not a real one. */
const MAX_WORKBOOK_BYTES = 8 * 1024 * 1024;

export class XlsxError extends Error {}

function readAt(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  const n = readSync(fd, buf, 0, length, position);
  return n === length ? buf : buf.subarray(0, n);
}

interface Entry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

function centralDirectory(fd: number, fileSize: number): Entry[] {
  const tailLen = Math.min(fileSize, 22 + 0xffff);
  const tail = readAt(fd, fileSize - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new XlsxError('not an .xlsx workbook (no zip directory found)');
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new XlsxError('workbooks over 4 GB are not supported');
  }
  if (cdOffset + cdSize > fileSize) throw new XlsxError('the workbook is damaged');
  const cd = readAt(fd, cdOffset, cdSize);
  const entries: Entry[] = [];
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.length; i++) {
    if (cd.readUInt32LE(p) !== CD_SIG) throw new XlsxError('the workbook is damaged');
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    entries.push({
      method: cd.readUInt16LE(p + 10),
      compressedSize: cd.readUInt32LE(p + 20),
      size: cd.readUInt32LE(p + 24),
      localOffset: cd.readUInt32LE(p + 42),
      name: cd.toString('utf8', p + 46, p + 46 + nameLen),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function entryData(fd: number, entry: Entry): Buffer {
  if (entry.size > MAX_WORKBOOK_BYTES || entry.compressedSize > MAX_WORKBOOK_BYTES) {
    throw new XlsxError('the workbook index is too large');
  }
  const header = readAt(fd, entry.localOffset, 30);
  if (header.length < 30 || header.readUInt32LE(0) !== LOCAL_SIG) {
    throw new XlsxError('the workbook is damaged');
  }
  const start = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  const raw = readAt(fd, start, entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return inflateRawSync(raw, { maxOutputLength: MAX_WORKBOOK_BYTES });
  throw new XlsxError('the workbook uses an unsupported compression method');
}

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    const lower = e.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    const code = lower.startsWith('#x')
      ? Number.parseInt(lower.slice(2), 16)
      : Number(lower.slice(1));
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

/** Sheet names from workbook.xml text, in workbook order. */
export function sheetsFromWorkbookXml(xml: string): string[] {
  const visible: string[] = [];
  const all: string[] = [];
  for (const m of xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?sheet\b([^>]*?)\/?>/g)) {
    const attrs = m[1] ?? '';
    const name = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attrs);
    if (!name) continue;
    const sheet = decodeXml(name[1] ?? name[2] ?? '');
    if (!sheet) continue;
    all.push(sheet);
    const state = /\bstate\s*=\s*["']([^"']*)["']/.exec(attrs)?.[1];
    if (state !== 'hidden' && state !== 'veryHidden') visible.push(sheet);
  }
  return visible.length > 0 ? visible : all;
}

/** Visible sheet names of the workbook at `path`. Throws XlsxError with a readable reason. */
export function xlsxSheetNames(path: string): string[] {
  const fd = openSync(path, 'r');
  try {
    const entries = centralDirectory(fd, fstatSync(fd).size);
    const workbook =
      entries.find((e) => e.name.toLowerCase() === 'xl/workbook.xml') ??
      entries.find((e) => /(^|\/)workbook\.xml$/i.test(e.name));
    if (!workbook) throw new XlsxError('not an .xlsx workbook (no sheet index)');
    const sheets = sheetsFromWorkbookXml(entryData(fd, workbook).toString('utf8'));
    if (sheets.length === 0) throw new XlsxError('the workbook has no sheets');
    return sheets;
  } finally {
    closeSync(fd);
  }
}
