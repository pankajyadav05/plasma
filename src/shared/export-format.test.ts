import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CSV_OPTIONS,
  DEFAULT_EXPORT_TABLE,
  createExportStreamer,
  csvEscape,
  exportExtension,
  exportMime,
  formatResultString,
  sqlLiteral,
} from './export-format';
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

describe('export-format edge cases', () => {
  const columns = [col('id', 'int4'), col('note', 'text')];

  it('quotes CSV cells containing delimiter, quote or newline and leaves plain text alone', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape('l1\nl2')).toBe('"l1\nl2"');
    expect(csvEscape(null)).toBe('');
  });

  it('serialises Date, bigint, boolean and array-ish values in SQL literals', () => {
    expect(sqlLiteral(new Date('2024-02-03T04:05:06.000Z'))).toBe("'2024-02-03T04:05:06.000Z'");
    expect(sqlLiteral(10n)).toBe('10');
    expect(sqlLiteral(true)).toBe('TRUE');
    expect(sqlLiteral(false)).toBe('FALSE');
    expect(sqlLiteral("O'Reilly")).toBe("'O''Reilly'");
    expect(sqlLiteral('{1,2}', col('a', 'int4[]'))).toBe("'{1,2}'");
    expect(sqlLiteral('\\xdeadbeef', col('b', 'bytea'))).toBe("'\\xdeadbeef'");
  });

  it('falls back to the default table name for SQL export', () => {
    const sql = formatResultString(columns, [[1, 'x']], 'sql');
    expect(sql).toContain(`INSERT INTO ${DEFAULT_EXPORT_TABLE}`);
  });

  it('streams valid JSON across several batches, including an empty result', () => {
    const chunks: string[] = [];
    const s = createExportStreamer('json', columns, (c) => {
      chunks.push(c);
    });
    s.begin();
    s.writeRows([[1, 'a']]);
    s.writeRows([[2, null]]);
    s.end();
    expect(JSON.parse(chunks.join(''))).toEqual([
      { id: 1, note: 'a' },
      { id: 2, note: null },
    ]);

    const empty: string[] = [];
    const e = createExportStreamer('json', columns, (c) => {
      empty.push(c);
    });
    e.begin();
    e.end();
    expect(JSON.parse(empty.join(''))).toEqual([]);
  });

  it('streams CSV with a BOM and header exactly once', () => {
    const chunks: string[] = [];
    const s = createExportStreamer('csv', columns, (c) => {
      chunks.push(c);
    });
    s.begin();
    s.writeRows([[1, 'a']]);
    s.writeRows([]);
    s.writeRows([[2, 'b']]);
    s.end();
    const out = chunks.join('');
    expect(out.startsWith('\uFEFF')).toBe(true);
    expect(out.match(/id,note/g)).toHaveLength(1);
    expect(out.trim().split(/\r?\n/)).toHaveLength(3);
  });

  it('maps formats to extension and mime type', () => {
    expect(exportExtension('csv')).toBe('csv');
    expect(exportExtension('json')).toBe('json');
    expect(exportExtension('sql')).toBe('sql');
    expect(exportMime('json')).toMatch(/json/);
  });
});

describe('CSV formula guard (SC-15)', () => {
  it('prefixes a quote on cells that spreadsheets would run as formulas', () => {
    expect(csvEscape('=HYPERLINK("http://evil","x")')).toBe(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csvEscape('+1+1')).toBe("'+1+1");
    expect(csvEscape('-cmd')).toBe("'-cmd");
    expect(csvEscape('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvEscape('\tTAB')).toBe("'\tTAB");
    expect(csvEscape('\rCR')).toBe(`"'\rCR"`);
  });

  it('leaves ordinary text, numbers and numeric strings alone', () => {
    expect(csvEscape('hello')).toBe('hello');
    expect(csvEscape(-5)).toBe('-5');
    expect(csvEscape('-12.50')).toBe('-12.50');
    expect(csvEscape('+3e5')).toBe('+3e5');
    expect(csvEscape('a=b')).toBe('a=b');
  });

  it('can be switched off', () => {
    expect(csvEscape('=1+1', { ...DEFAULT_CSV_OPTIONS, formulaGuard: false })).toBe('=1+1');
  });

  it('applies to TSV too', () => {
    expect(csvEscape('=1', { ...DEFAULT_CSV_OPTIONS, delimiter: '\t' })).toBe("'=1");
  });
});

describe('JSON export fidelity (P2-4)', () => {
  const cols = (...names: string[]): ColumnMeta[] =>
    names.map((name) => ({ name, dataTypeID: 25, dataTypeName: 'text' }));

  it('keeps duplicate column names as separate keys', () => {
    const out = formatResultString(cols('a', 'a', 'a', 'b'), [[1, 2, 3, 4]], 'json');
    expect(JSON.parse(out)).toEqual([{ a: 1, a_2: 2, a_3: 3, b: 4 }]);
  });

  it('writes NaN and Infinity as strings instead of silently turning them into null', () => {
    const out = formatResultString(
      cols('x', 'y', 'z'),
      [[Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]],
      'json',
    );
    expect(JSON.parse(out)).toEqual([{ x: 'NaN', y: 'Infinity', z: '-Infinity' }]);
  });
});
