import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeTestXlsx } from './test-xlsx';
import { XlsxError, sheetsFromWorkbookXml, xlsxSheetNames } from './xlsx-sheets';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plasma-xlsx-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('xlsxSheetNames', () => {
  it('lists sheets in workbook order, decoding XML entities', () => {
    const path = join(dir, 'two.xlsx');
    writeTestXlsx(path, [
      { name: 'Q1 Sales', rows: [['a'], [1]] },
      { name: 'Regions & "Reps"', rows: [['b'], [2]] },
    ]);
    expect(xlsxSheetNames(path)).toEqual(['Q1 Sales', 'Regions & "Reps"']);
  });

  it('reads stored (uncompressed) entries too', () => {
    const path = join(dir, 'stored.xlsx');
    writeTestXlsx(path, [{ name: 'Only', rows: [['a']] }], { store: true });
    expect(xlsxSheetNames(path)).toEqual(['Only']);
  });

  it('skips hidden sheets, unless every sheet is hidden', () => {
    const some = join(dir, 'hidden.xlsx');
    writeTestXlsx(some, [
      { name: 'Data', rows: [['a']] },
      { name: 'Lookup', rows: [['b']], state: 'hidden' },
      { name: 'Secret', rows: [['c']], state: 'veryHidden' },
    ]);
    expect(xlsxSheetNames(some)).toEqual(['Data']);
    expect(
      sheetsFromWorkbookXml(
        '<sheets><sheet name="A" state="hidden"/><sheet name="B" state="hidden"/></sheets>',
      ),
    ).toEqual(['A', 'B']);
  });

  it('handles prefixed elements and single-quoted attributes', () => {
    expect(
      sheetsFromWorkbookXml(
        "<x:sheets><x:sheet name='One' sheetId='1'/><x:sheet name=\"T&#233;l&#x00E9;\" /></x:sheets>",
      ),
    ).toEqual(['One', 'Télé']);
  });

  it('refuses files that are not workbooks with a readable reason', () => {
    const notZip = join(dir, 'fake.xlsx');
    writeFileSync(notZip, 'id,name\n1,a\n');
    expect(() => xlsxSheetNames(notZip)).toThrow(XlsxError);
    expect(() => xlsxSheetNames(notZip)).toThrow(/not an \.xlsx workbook/);
  });
});
