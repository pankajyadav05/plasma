import { describe, expect, it } from 'vitest';
import { csvEscape, formatResultString, sqlLiteral } from './export-format';
import type { ColumnMeta } from './protocol';

const col = (name: string, dataTypeName: string): ColumnMeta => ({
  name,
  dataTypeID: 0,
  dataTypeName,
});

describe('export-format (F7)', () => {
  const columns = [
    col('d', 'date'),
    col('ts', 'timestamp'),
    col('tags', 'text[]'),
    col('blob', 'bytea'),
    col('doc', 'jsonb'),
    col('n', 'numeric'),
  ];
  const row = [
    '2024-01-05',
    '2024-01-05 10:11:12.123456',
    '{a,b}',
    '\\xdead',
    { k: "it's" },
    '1.10',
  ];

  it('writes SQL INSERTs with the real table and verbatim Postgres text', () => {
    const sql = formatResultString(columns, [row], 'sql', { targetTable: '"public"."t"' });
    expect(sql).toBe(
      `INSERT INTO "public"."t" ("d", "ts", "tags", "blob", "doc", "n") VALUES ('2024-01-05', '2024-01-05 10:11:12.123456', '{a,b}', '\\xdead', '{"k":"it''s"}'::jsonb, '1.10');\n`,
    );
  });

  it('writes CSV without JSON-quoting strings or shifting dates', () => {
    const csv = formatResultString(columns, [row], 'csv', { bom: false });
    expect(csv.split('\r\n')[1]).toBe(
      `2024-01-05,2024-01-05 10:11:12.123456,"{a,b}",\\xdead,"{""k"":""it's""}",1.10`,
    );
  });

  it('handles nulls, non-finite numbers and json scalars', () => {
    expect(sqlLiteral(null)).toBe('NULL');
    expect(sqlLiteral(Number.NaN)).toBe("'NaN'");
    expect(sqlLiteral('x', col('j', 'json'))).toBe(`'"x"'::json`);
    expect(csvEscape(new Date('2024-01-01T00:00:00Z'))).toBe('2024-01-01T00:00:00.000Z');
  });
});

describe('CSV options (Settings → Data)', () => {
  const columns = [
    { name: 'a', dataTypeId: 25, dataTypeName: 'text' },
    { name: 'b', dataTypeId: 25, dataTypeName: 'text' },
  ] as never;
  it('applies delimiter, quote, NULL literal and line ending', () => {
    const out = formatResultString(
      columns,
      [
        ['x;y', null],
        ["it's", 'z'],
      ],
      'csv',
      {
        bom: false,
        csv: { delimiter: ';', header: true, quote: "'", nullAs: 'NULL', lineEnding: 'lf' },
      },
    );
    expect(out).toBe("a;b\n'x;y';NULL\n'it''s';z\n");
  });
  it('can omit the header row', () => {
    const out = formatResultString(columns, [['1', '2']], 'csv', {
      bom: false,
      csv: { delimiter: '|', header: false, quote: '"', nullAs: 'empty', lineEnding: 'crlf' },
    });
    expect(out).toBe('1|2\r\n');
  });
  it('default dialect is unchanged', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape(null)).toBe('');
  });
});
