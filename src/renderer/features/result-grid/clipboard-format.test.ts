import type { ColumnMeta } from '@shared/protocol';
import { describe, expect, it } from 'vitest';
import { formatRows, parseClipboardBlock } from './clipboard-format';

const columns: ColumnMeta[] = [
  { name: 'id', dataTypeID: 20, dataTypeName: 'int8' },
  { name: 'name', dataTypeID: 25, dataTypeName: 'text' },
  { name: 'meta', dataTypeID: 3802, dataTypeName: 'jsonb' },
];
const rows = [
  ['1', 'Ann, "A"', { tags: ['x'] }],
  ['2', null, null],
];

describe('formatRows', () => {
  it('TSV marks NULL and quotes tabs/quotes', () => {
    expect(formatRows('tsv', columns, rows, [0, 1])).toBe('1\t"Ann, ""A"""\n2\tNULL');
  });

  it('CSV with and without header', () => {
    expect(formatRows('csv', columns, rows, [0, 1])).toBe('1,"Ann, ""A"""\n2,');
    expect(formatRows('csv-header', columns, rows, [0, 1]).split('\n')[0]).toBe('id,name');
  });

  it('JSON keeps json documents typed', () => {
    const parsed = JSON.parse(formatRows('json', columns, rows, [0, 2]));
    expect(parsed).toEqual([
      { id: '1', meta: { tags: ['x'] } },
      { id: '2', meta: null },
    ]);
  });

  it('Markdown escapes pipes', () => {
    const md = formatRows('markdown', columns, [['1', 'a|b', null]], [0, 1]);
    expect(md).toBe('| id | name |\n| --- | --- |\n| 1 | a\\|b |');
  });

  it('SQL INSERT uses the real table and escapes quotes', () => {
    const sql = formatRows('sql', columns, [['1', "O'Neil", { a: 1 }]], [0, 1, 2], {
      schema: 'public',
      name: 'people',
    });
    expect(sql).toBe(
      `INSERT INTO "public"."people" ("id", "name", "meta") VALUES ('1', 'O''Neil', '{"a":1}');`,
    );
  });
});

describe('parseClipboardBlock', () => {
  it('parses a TSV block with NULL and quoted fields', () => {
    expect(parseClipboardBlock('a\tNULL\n"x\ty"\t"he said ""hi"""\n')).toEqual([
      ['a', null],
      ['x\ty', 'he said "hi"'],
    ]);
  });

  it('keeps a quoted "NULL" as text and handles CRLF', () => {
    expect(parseClipboardBlock('"NULL"\r\nb')).toEqual([['NULL'], ['b']]);
  });

  it('round-trips TSV produced by formatRows', () => {
    const tsv = formatRows('tsv', columns, rows, [0, 1]);
    expect(parseClipboardBlock(tsv)).toEqual([
      ['1', 'Ann, "A"'],
      ['2', null],
    ]);
  });
});
