import { describe, expect, it } from 'vitest';
import {
  CsvParser,
  JsonArrayStream,
  LineSplitter,
  detectDelimiter,
  detectHeader,
  formatFromPath,
  inferColumnTypes,
  jsonCell,
  jsonKeys,
  parseCsv,
  parseJsonObject,
  sanitizeColumnName,
} from './import-parse';

const opts = { delimiter: ',', quote: '"', nullString: null as string | null };

describe('formatFromPath', () => {
  it('maps extensions', () => {
    expect(formatFromPath('/a/b.CSV')).toBe('csv');
    expect(formatFromPath('x.tsv')).toBe('tsv');
    expect(formatFromPath('x.jsonl')).toBe('ndjson');
    expect(formatFromPath('x.json')).toBe('json');
    expect(formatFromPath('x.sql')).toBe('sql');
    expect(formatFromPath('x.bin')).toBeNull();
  });
});

describe('CsvParser', () => {
  it('parses quotes, embedded delimiters, newlines and doubled quotes', () => {
    expect(parseCsv('a,"b,c","d\ne","f""g"\n1,2,3,4\n', opts)).toEqual([
      ['a', 'b,c', 'd\ne', 'f"g'],
      ['1', '2', '3', '4'],
    ]);
  });
  it('handles CRLF, lone CR, missing final newline and blank lines', () => {
    expect(parseCsv('a,b\r\n\r\nc,d\re,f', opts)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
    ]);
  });
  it('keeps trailing empty cells', () => {
    expect(parseCsv('a,,\n,b,', opts)).toEqual([
      ['a', '', ''],
      ['', 'b', ''],
    ]);
  });
  it('is chunk-boundary safe at every split point', () => {
    const text = 'id,name\r\n1,"Ann ""A"", x\ny"\r\n2,\r\n3,plain';
    const whole = parseCsv(text, opts);
    for (let i = 0; i <= text.length; i++) {
      const p = new CsvParser(opts);
      const rows = [...p.push(text.slice(0, i)), ...p.push(text.slice(i)), ...p.end()];
      expect(rows, `split at ${i}`).toEqual(whole);
    }
  });
  it('maps the NULL string only when unquoted', () => {
    const rows = parseCsv('a,NULL,"NULL",\n', { ...opts, nullString: 'NULL' });
    expect(rows).toEqual([['a', null, 'NULL', '']]);
    expect(parseCsv('a,,"",b\n', { ...opts, nullString: '' })).toEqual([['a', null, '', 'b']]);
  });
  it('supports other delimiters and no quote char', () => {
    expect(parseCsv('a\tb\n1\t"2\n', { delimiter: '\t', quote: '', nullString: null })).toEqual([
      ['a', 'b'],
      ['1', '"2'],
    ]);
    expect(parseCsv("a;'b;c'\n", { delimiter: ';', quote: "'", nullString: null })).toEqual([
      ['a', 'b;c'],
    ]);
  });
  it('errors on an unterminated quote and bad options', () => {
    const p = new CsvParser(opts);
    p.push('a,"oops');
    expect(() => p.end()).toThrow(/quote/);
    expect(() => new CsvParser({ ...opts, delimiter: ',,' })).toThrow();
    expect(() => new CsvParser({ ...opts, quote: ',' })).toThrow();
  });
});

describe('detectDelimiter / detectHeader', () => {
  it('detects the consistent delimiter', () => {
    expect(detectDelimiter('a,b,c\n1,2,3\n')).toBe(',');
    expect(detectDelimiter('a;b;c\n1;2;3\n')).toBe(';');
    expect(detectDelimiter('a\tb\n1\t2\n')).toBe('\t');
    expect(detectDelimiter('a|b|c\n1|2|3\n')).toBe('|');
    expect(detectDelimiter('"a,b";c\n"1,2";3\n')).toBe(';');
    expect(detectDelimiter('single\nlines\n')).toBe(',');
  });
  it('detects headers', () => {
    expect(
      detectHeader([
        ['id', 'name'],
        ['1', 'a'],
      ]),
    ).toBe(true);
    expect(
      detectHeader([
        ['1', 'a'],
        ['2', 'b'],
      ]),
    ).toBe(false);
    expect(
      detectHeader([
        ['id', 'id'],
        ['1', 'a'],
      ]),
    ).toBe(false);
    expect(
      detectHeader([
        ['id', ''],
        ['1', 'a'],
      ]),
    ).toBe(false);
    expect(detectHeader([])).toBe(false);
  });
});

describe('type inference', () => {
  const t = (...vals: (string | null)[]) =>
    inferColumnTypes(
      vals.map((v) => [v]),
      1,
    )[0];
  it('infers scalars', () => {
    expect(t('1', '2', '-3')).toBe('integer');
    expect(t('1', '3000000000')).toBe('bigint');
    expect(t('1', '99999999999999999999')).toBe('numeric');
    expect(t('1', '2.5', '1e3')).toBe('numeric');
    expect(t('true', 'F')).toBe('boolean');
    expect(t('2024-01-02', '2025-12-31')).toBe('date');
    expect(t('2024-01-02 10:00:00', '2024-01-02T10:00')).toBe('timestamp');
    expect(t('2024-01-02T10:00:00Z', '2024-01-02 10:00:00+02')).toBe('timestamptz');
    expect(t('123e4567-e89b-12d3-a456-426614174000')).toBe('uuid');
    expect(t('{"a":1}', '[1,2]')).toBe('jsonb');
  });
  it('falls back to text', () => {
    expect(t('007')).toBe('text');
    expect(t('1', 'x')).toBe('text');
    expect(t('{oops}')).toBe('text');
    expect(t(null, '')).toBe('text');
  });
  it('ignores nulls when inferring', () => {
    expect(t('1', null, '', '2')).toBe('integer');
  });
});

describe('sanitizeColumnName', () => {
  it('lowercases, replaces and dedupes', () => {
    const used = new Set<string>();
    expect(sanitizeColumnName('First Name', 0, used)).toBe('first_name');
    expect(sanitizeColumnName('first name', 1, used)).toBe('first_name_2');
    expect(sanitizeColumnName('2fa', 2, used)).toBe('_2fa');
    expect(sanitizeColumnName('  ', 3, used)).toBe('column_4');
    expect(sanitizeColumnName('Ünï-cödé!', 4, used)).toBe('ünï_cödé');
    expect(sanitizeColumnName('x'.repeat(100), 5, used).length).toBe(55);
  });
});

describe('JsonArrayStream', () => {
  const text = '  [ {"a":1,"s":"x}]\\"y"}, {"b":[1,{"c":2}]} ,\n{"d":null} ]  ';
  it('splits objects, respecting strings and nesting', () => {
    const s = new JsonArrayStream();
    const out = s.push(text);
    s.end();
    expect(out.map((o) => JSON.parse(o))).toEqual([
      { a: 1, s: 'x}]"y' },
      { b: [1, { c: 2 }] },
      { d: null },
    ]);
  });
  it('is chunk-boundary safe', () => {
    for (let i = 0; i <= text.length; i++) {
      const s = new JsonArrayStream();
      const out = [...s.push(text.slice(0, i)), ...s.push(text.slice(i))];
      s.end();
      expect(out.length, `split at ${i}`).toBe(3);
    }
  });
  it('rejects non-array input, scalar elements and unclosed arrays', () => {
    expect(() => new JsonArrayStream().push('{"a":1}')).toThrow(/single object/);
    expect(() => new JsonArrayStream().push('[1,2]')).toThrow(/object/);
    const s = new JsonArrayStream();
    s.push('[{"a":1}');
    expect(() => s.end()).toThrow(/not closed/);
    expect(() => new JsonArrayStream().end()).toThrow(/empty/);
    expect(() => new JsonArrayStream().push('[] x')).toThrow(/after/);
  });
});

describe('NDJSON / json helpers', () => {
  it('splits lines across chunks', () => {
    const l = new LineSplitter();
    expect([...l.push('{"a":1}\n{"a"'), ...l.push(':2}\r\n\n{"a":3}'), ...l.end()]).toEqual([
      '{"a":1}',
      '{"a":2}',
      '{"a":3}',
    ]);
  });
  it('parses objects only', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(() => parseJsonObject('[1]')).toThrow();
    expect(() => parseJsonObject('3')).toThrow();
  });
  it('renders json cells', () => {
    expect(jsonCell(null)).toBeNull();
    expect(jsonCell(undefined)).toBeNull();
    expect(jsonCell('s')).toBe('s');
    expect(jsonCell(5)).toBe('5');
    expect(jsonCell(true)).toBe('true');
    expect(jsonCell({ a: [1] })).toBe('{"a":[1]}');
    expect(jsonKeys([{ a: 1 }, { b: 2, a: 3 }])).toEqual(['a', 'b']);
  });
});
