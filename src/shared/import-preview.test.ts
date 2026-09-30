import { describe, expect, it } from 'vitest';
import { buildImportPreview } from './import-preview';

const p = (
  format: 'csv' | 'tsv' | 'json' | 'ndjson' | 'sql',
  text: string,
  truncated = false,
  csv?: object,
) => buildImportPreview({ path: '/x', format, csv }, text, text.length, truncated);

describe('buildImportPreview', () => {
  it('csv: detects delimiter and header, infers types', () => {
    const r = p('csv', 'id;name;active;born\n1;Ann;true;2000-01-01\n2;Bob;false;1999-12-31\n');
    expect(r.csv).toEqual({ delimiter: ';', quote: '"', header: true, nullString: '' });
    expect(r.columns).toEqual(['id', 'name', 'active', 'born']);
    expect(r.rows).toEqual([
      ['1', 'Ann', 'true', '2000-01-01'],
      ['2', 'Bob', 'false', '1999-12-31'],
    ]);
    expect(r.types).toEqual(['integer', 'text', 'boolean', 'date']);
  });
  it('csv: no header -> column N labels and first row is data', () => {
    const r = p('csv', '1,a\n2,b\n');
    expect(r.csv?.header).toBe(false);
    expect(r.columns).toEqual(['column 1', 'column 2']);
    expect(r.rows).toHaveLength(2);
  });
  it('csv: explicit options override detection; empty cells become NULL by default', () => {
    const r = p('csv', 'a|b\n1|\n', false, { delimiter: '|', header: true });
    expect(r.rows).toEqual([['1', null]]);
    const r2 = p('csv', 'a,b\n1,\n', false, { nullString: 'NULL' });
    expect(r2.rows).toEqual([['1', '']]);
  });
  it('tsv defaults to tab; BOM is stripped', () => {
    const r = p('tsv', '﻿a\tb\n1\t2\n');
    expect(r.columns).toEqual(['a', 'b']);
  });
  it('drops the cut last row when truncated', () => {
    const r = p('csv', 'a,b\n1,2\n3,', true);
    expect(r.rows).toEqual([['1', '2']]);
    expect(r.truncated).toBe(true);
  });
  it('json array and ndjson: union of keys', () => {
    const arr = p('json', '[{"id":1,"tags":["a"]},{"id":2,"name":"x"}]');
    expect(arr.columns).toEqual(['id', 'tags', 'name']);
    expect(arr.rows[0]).toEqual(['1', '["a"]', null]);
    expect(arr.types).toEqual(['integer', 'jsonb', 'text']);
    const nd = p('ndjson', '{"a":1}\n{"b":true}');
    expect(nd.columns).toEqual(['a', 'b']);
    expect(nd.rows).toHaveLength(2);
    const cut = p('ndjson', '{"a":1}\n{"a":', true);
    expect(cut.rows).toHaveLength(1);
  });
  it('sql: lists statements', () => {
    const r = p('sql', "create table t(a int);\ninsert into t values (1);\nselect 'a;b';");
    expect(r.statements).toEqual([
      'create table t(a int)',
      'insert into t values (1)',
      "select 'a;b'",
    ]);
  });
  it('empty file gives no columns', () => {
    expect(p('csv', '').columns).toEqual([]);
    expect(p('json', '[]').columns).toEqual([]);
  });
});
