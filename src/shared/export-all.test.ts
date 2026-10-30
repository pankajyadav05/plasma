import { describe, expect, it } from 'vitest';
import {
  exportAllExtension,
  exportableResults,
  firstTableOf,
  formatAllResultsJson,
  sheetNames,
  zipEntryNames,
} from './export-all';
import type { QueryResult } from './protocol';

const result = (sql: string, columns: string[]): QueryResult => ({
  columns: columns.map((name) => ({ name, dataTypeID: 0, dataTypeName: 'text' })),
  rows: [],
  rowCount: 0,
  durationMs: 1,
  sql,
});

describe('firstTableOf', () => {
  it('finds the first table, with or without schema and quotes', () => {
    expect(firstTableOf('select * from orders')).toBe('orders');
    expect(firstTableOf('SELECT id FROM public.survey_storage WHERE id = 1')).toBe(
      'survey_storage',
    );
    expect(firstTableOf('select 1 from "My Schema"."Order Lines" o')).toBe('Order Lines');
    expect(firstTableOf('select `x` from `db`.`t`')).toBe('t');
    expect(firstTableOf('-- from comments\nselect now()')).toBeNull();
    expect(firstTableOf(undefined)).toBeNull();
  });
});

describe('exportableResults', () => {
  it('keeps row-returning results, numbered like the result tabs', () => {
    const out = exportableResults([
      result('select * from a', ['x']),
      result('update a set x = 1', []),
      result('select 1 as one', ['one']),
    ]);
    expect(out.map((r) => r.label)).toEqual(['Result 1 · a', 'Result 3']);
  });
});

describe('sheetNames', () => {
  it('removes characters Excel forbids, keeps 31 characters, stays unique', () => {
    expect(sheetNames(['a/b:c', 'Result 1 · a_very_long_table_name_for_sheets', 'X', 'x'])).toEqual(
      ['a b c', 'Result 1 · a_very_long_table_na', 'X', 'x (2)'],
    );
    expect(sheetNames(["'quoted'", ''])).toEqual(['quoted', 'Sheet 2']);
  });
});

describe('zipEntryNames', () => {
  it('slugs labels and keeps them unique', () => {
    expect(zipEntryNames(['Result 1 · orders', 'Result 1 · orders', '···'], 'csv')).toEqual([
      'result-1-orders.csv',
      'result-1-orders-2.csv',
      'result-3.csv',
    ]);
  });
});

describe('exportAllExtension', () => {
  it('is xlsx for a workbook, zip otherwise', () => {
    expect(exportAllExtension('xlsx')).toBe('xlsx');
    expect(exportAllExtension('csv')).toBe('zip');
    expect(exportAllExtension('json')).toBe('zip');
  });
});

describe('formatAllResultsJson', () => {
  it('keys every result by its label, rows as objects', () => {
    const col = (name: string) => ({ name, dataTypeID: 0, dataTypeName: 'text' });
    const json = formatAllResultsJson([
      { label: 'Result 1 · orders', columns: [col('id'), col('id')], rows: [[1, 2]] },
      { label: 'Result 2', columns: [col('n')], rows: [[12n], [Number.NaN]] },
      { label: 'Result 2', columns: [col('x')], rows: [] },
    ]);
    expect(JSON.parse(json)).toEqual({
      'Result 1 · orders': [{ id: 1, id_2: 2 }],
      'Result 2': [{ n: '12' }, { n: 'NaN' }],
      'Result 2 (2)': [],
    });
  });
});
