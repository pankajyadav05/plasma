import { crc32, deflateRawSync } from 'node:zlib';
import {
  type ExportAllFormat,
  type NamedResult,
  sheetNames,
  zipEntryNames,
} from '@shared/export-all';
import { type CsvOptions, type ExportFormat, formatResultString } from '@shared/export-format';
import type { SqlDialect } from '@shared/sql-dialect';

/**
 * Writes "Export all results" files: an .xlsx workbook with one sheet per
 * result, or a .zip with one CSV / JSON file per result. Both are zip
 * archives, built here with node:zlib (no dependency). The results are the
 * ones already loaded in the window, so everything fits in memory.
 */

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/** The archive stays a plain (non-ZIP64) zip: under 4 GB and 65,535 entries. */
const ZIP_LIMIT = 0xffff_ffff;

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** A zip archive of `entries`, deflated, with UTF-8 names. */
export function buildZip(entries: readonly ZipEntry[], now = new Date()): Buffer {
  if (entries.length > 0xffff) throw new Error('Too many files for one archive.');
  const { time, date } = dosDateTime(now);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const packed = deflateRawSync(entry.data);
    const crc = crc32(entry.data) >>> 0;
    if (entry.data.length > ZIP_LIMIT || offset > ZIP_LIMIT) {
      throw new Error('The export is too large for one archive.');
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    // extra, comment, disk, internal and external attributes stay 0
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  if (offset + directory.length > ZIP_LIMIT)
    throw new Error('The export is too large for one archive.');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// ── xlsx ────────────────────────────────────────────────────────────

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
/** Excel refuses longer text in one cell. */
const CELL_TEXT_MAX = 32_767;
/** Excel's last row; a longer result is cut there (the sheet says so). */
export const XLSX_MAX_ROWS = 1_048_576;

/** Characters XML 1.0 cannot hold. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters XML 1.0 forbids
const XML_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

/** XML text: escaped, without the control characters XML 1.0 forbids. */
function xmlText(s: string): string {
  return s
    .replace(XML_FORBIDDEN, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A1-style column letters for a zero-based index. */
export function columnLetters(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function textCell(ref: string, text: string, style = 0): string {
  const t = text.length > CELL_TEXT_MAX ? text.slice(0, CELL_TEXT_MAX) : text;
  const space = /^\s|\s$/.test(t) ? ' xml:space="preserve"' : '';
  return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t${space}>${xmlText(t)}</t></is></c>`;
}

/**
 * One cell. Numbers and booleans keep their type; everything else is text, so
 * big integers and exact decimals (which arrive as strings) never lose digits.
 * Text is never a formula, whatever it starts with.
 */
function cell(ref: string, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? `<c r="${ref}"><v>${value}</v></c>`
      : textCell(ref, String(value));
  }
  if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  if (typeof value === 'bigint') return textCell(ref, value.toString());
  if (value instanceof Date) return textCell(ref, value.toISOString());
  if (value instanceof Uint8Array) return textCell(ref, `\\x${Buffer.from(value).toString('hex')}`);
  if (typeof value === 'object') {
    try {
      return textCell(ref, JSON.stringify(value));
    } catch {
      return textCell(ref, String(value));
    }
  }
  return textCell(ref, String(value));
}

function sheetXml(result: NamedResult): string {
  const rows =
    result.rows.length > XLSX_MAX_ROWS - 1 ? result.rows.slice(0, XLSX_MAX_ROWS - 1) : result.rows;
  const letters = result.columns.map((_, i) => columnLetters(i));
  const parts: string[] = [
    XML_HEAD,
    `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`,
    // The header row stays in view while scrolling.
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>',
    '<sheetData>',
    `<row r="1">${result.columns.map((c, i) => textCell(`${letters[i]}1`, c.name, 1)).join('')}</row>`,
  ];
  rows.forEach((row, r) => {
    const n = r + 2;
    let cells = '';
    for (let i = 0; i < letters.length; i++) cells += cell(`${letters[i]}${n}`, row[i]);
    parts.push(`<row r="${n}">${cells}</row>`);
  });
  parts.push('</sheetData>');
  if (result.columns.length > 0) {
    parts.push(`<autoFilter ref="A1:${letters[letters.length - 1]}${rows.length + 1}"/>`);
  }
  parts.push('</worksheet>');
  return parts.join('');
}

const STYLES_XML = `${XML_HEAD}<styleSheet xmlns="${NS_MAIN}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`;

/** An .xlsx workbook with one sheet per result, header row bold and frozen. */
export function buildXlsx(results: readonly NamedResult[], now = new Date()): Buffer {
  if (results.length === 0) throw new Error('Nothing to export.');
  const names = sheetNames(results.map((r) => r.label));
  const sheets = results.map((_, i) => i + 1);
  const contentTypes = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets
    .map(
      (n) =>
        `<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join('')}</Types>`;
  const rootRels = `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const workbook = `${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets>${sheets
    .map(
      (n, i) =>
        `<sheet name="${xmlText(names[i] ?? `Sheet ${n}`)}" sheetId="${n}" r:id="rId${n}"/>`,
    )
    .join('')}</sheets></workbook>`;
  const workbookRels = `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">${sheets
    .map(
      (n) =>
        `<Relationship Id="rId${n}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${n}.xml"/>`,
    )
    .join(
      '',
    )}<Relationship Id="rId${sheets.length + 1}" Type="${NS_REL}/styles" Target="styles.xml"/></Relationships>`;

  return buildZip(
    [
      { name: '[Content_Types].xml', data: Buffer.from(contentTypes) },
      { name: '_rels/.rels', data: Buffer.from(rootRels) },
      { name: 'xl/workbook.xml', data: Buffer.from(workbook) },
      { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels) },
      { name: 'xl/styles.xml', data: Buffer.from(STYLES_XML) },
      ...results.map((r, i) => ({
        name: `xl/worksheets/sheet${i + 1}.xml`,
        data: Buffer.from(sheetXml(r)),
      })),
    ],
    now,
  );
}

/** The bytes of an "Export all results" file, and how many rows went in. */
export function buildExportAll(
  format: ExportAllFormat,
  results: readonly NamedResult[],
  opts: { csv?: CsvOptions; dialect?: SqlDialect; now?: Date } = {},
): { data: Buffer; rowCount: number } {
  if (results.length === 0) throw new Error('Nothing to export.');
  const rowCount = results.reduce(
    (n, r) => n + (format === 'xlsx' ? Math.min(r.rows.length, XLSX_MAX_ROWS - 1) : r.rows.length),
    0,
  );
  if (format === 'xlsx') return { data: buildXlsx(results, opts.now), rowCount };
  const fileFormat: ExportFormat = format;
  const names = zipEntryNames(
    results.map((r) => r.label),
    fileFormat,
  );
  const entries = results.map((r, i) => ({
    name: names[i] ?? `result-${i + 1}.${fileFormat}`,
    data: Buffer.from(
      formatResultString(r.columns, r.rows, fileFormat, { csv: opts.csv, dialect: opts.dialect }),
      'utf8',
    ),
  }));
  return { data: buildZip(entries, opts.now), rowCount };
}
