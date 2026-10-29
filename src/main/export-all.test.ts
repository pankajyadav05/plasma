import { inflateRawSync } from 'node:zlib';
import type { NamedResult } from '@shared/export-all';
import { describe, expect, it } from 'vitest';
import { XLSX_MAX_ROWS, buildExportAll, buildXlsx, buildZip, columnLetters } from './export-all';

/** Reads a zip through its central directory, the way unzip and Excel do. */
function readZip(buf: Buffer): Map<string, string> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThan(-1);
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const files = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    expect(buf.readUInt32LE(local)).toBe(0x04034b50);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    files.set(name, inflateRawSync(buf.subarray(dataStart, dataStart + size)).toString('utf8'));
    p += 46 + nameLen;
  }
  return files;
}

const cols = (...names: string[]) =>
  names.map((name) => ({ name, dataTypeID: 0, dataTypeName: 'text' }));

const people: NamedResult = {
  label: 'Result 1 · people',
  columns: cols('id', 'name', 'active', 'note'),
  rows: [
    [1, 'Ana', true, null],
    [2, '  <b>&"x"', false, { a: 1 }],
    ['9007199254740993', '=SUM(A1)', null, 'tab\there'],
  ],
};
const orders: NamedResult = {
  label: 'Result 2 · orders',
  columns: cols('order_id', 'total'),
  rows: [[10, '19.990']],
};

describe('buildZip', () => {
  it('round-trips names (UTF-8) and contents', () => {
    const zip = buildZip([
      { name: 'a.txt', data: Buffer.from('hello') },
      { name: 'dossier/é.csv', data: Buffer.from('x'.repeat(5000)) },
    ]);
    const files = readZip(zip);
    expect([...files.keys()]).toEqual(['a.txt', 'dossier/é.csv']);
    expect(files.get('a.txt')).toBe('hello');
    expect(files.get('dossier/é.csv')).toBe('x'.repeat(5000));
  });
});

describe('columnLetters', () => {
  it('counts like Excel', () => {
    expect([0, 25, 26, 27, 51, 52, 701, 702].map(columnLetters)).toEqual([
      'A',
      'Z',
      'AA',
      'AB',
      'AZ',
      'BA',
      'ZZ',
      'AAA',
    ]);
  });
});

describe('buildXlsx', () => {
  const files = readZip(buildXlsx([people, orders]));

  it('has the parts Excel needs, one sheet per result', () => {
    expect([...files.keys()]).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
    ]);
    const workbook = files.get('xl/workbook.xml') ?? '';
    expect(workbook).toContain('<sheet name="Result 1 · people" sheetId="1" r:id="rId1"/>');
    expect(workbook).toContain('<sheet name="Result 2 · orders" sheetId="2" r:id="rId2"/>');
    expect(files.get('xl/_rels/workbook.xml.rels')).toContain('Target="styles.xml"');
  });

  it('writes a bold, frozen header and typed cells', () => {
    const sheet = files.get('xl/worksheets/sheet1.xml') ?? '';
    expect(sheet).toContain('<c r="A1" t="inlineStr" s="1"><is><t>id</t></is></c>');
    expect(sheet).toContain('state="frozen"');
    expect(sheet).toContain('<c r="A2"><v>1</v></c>');
    expect(sheet).toContain('<c r="C2" t="b"><v>1</v></c>');
    // NULL is an empty cell.
    expect(sheet).not.toContain('r="D2"');
    // Escaped, leading spaces kept.
    expect(sheet).toContain('<t xml:space="preserve">  &lt;b&gt;&amp;&quot;x&quot;</t>');
    expect(sheet).toContain('<t>{&quot;a&quot;:1}</t>');
    // A big integer stays text with every digit; a formula-looking string stays text.
    expect(sheet).toContain('<c r="A4" t="inlineStr"><is><t>9007199254740993</t></is></c>');
    expect(sheet).toContain('<c r="B4" t="inlineStr"><is><t>=SUM(A1)</t></is></c>');
    expect(sheet).not.toContain('<f>');
    expect(sheet).toContain('<autoFilter ref="A1:D4"/>');
  });

  it('drops characters XML cannot hold', () => {
    const sheet = readZip(
      buildXlsx([{ label: 'x', columns: cols('v'), rows: [['a\u0001b']] }]),
    ).get('xl/worksheets/sheet1.xml');
    expect(sheet).toContain('<t>ab</t>');
  });

  it('cuts a result at Excel’s last row', () => {
    const rows = Array.from({ length: XLSX_MAX_ROWS + 5 }, (_, i) => [i]);
    const { rowCount } = buildExportAll('xlsx', [{ label: 'big', columns: cols('n'), rows }]);
    expect(rowCount).toBe(XLSX_MAX_ROWS - 1);
  }, 60_000);
});

describe('buildExportAll', () => {
  it('zips one CSV per result, named after the result', () => {
    const { data, rowCount } = buildExportAll('csv', [people, orders]);
    expect(rowCount).toBe(4);
    const files = readZip(data);
    expect([...files.keys()]).toEqual(['result-1-people.csv', 'result-2-orders.csv']);
    expect(files.get('result-2-orders.csv')).toContain('order_id,total');
    expect(files.get('result-2-orders.csv')).toContain('10,19.990');
    // CSV keeps its formula guard.
    expect(files.get('result-1-people.csv')).toContain("'=SUM(A1)");
  });

  it('zips one JSON file per result', () => {
    const files = readZip(buildExportAll('json', [orders]).data);
    expect(JSON.parse(files.get('result-2-orders.json') ?? '')).toEqual([
      { order_id: 10, total: '19.990' },
    ]);
  });

  it('refuses an empty export', () => {
    expect(() => buildExportAll('xlsx', [])).toThrow('Nothing to export.');
  });
});
