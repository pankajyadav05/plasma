import type { ImportPreview } from '@shared/protocol';
import { describe, expect, it } from 'vitest';
import {
  autoMap,
  buildImportJob,
  describeImportSql,
  formatBytes,
  newTableColumns,
  tableNameFromFile,
} from './import-model';

const csvPreview: ImportPreview = {
  path: '/tmp/People List.csv',
  format: 'csv',
  size: 100,
  csv: { delimiter: ',', quote: '"', header: true, nullString: '' },
  columns: ['ID', 'Full Name', 'joined at', 'extra'],
  rows: [['1', 'Ann', '2024-01-01', 'x']],
  types: ['integer', 'text', 'date', 'text'],
  truncated: false,
};

describe('autoMap', () => {
  it('matches loosely by name and never uses a target twice', () => {
    expect(
      autoMap(['ID', 'Full Name', 'joined at', 'id'], ['id', 'full_name', 'joined_at'], false),
    ).toEqual(['id', 'full_name', 'joined_at', null]);
  });
  it('falls back to positions for header-less files', () => {
    expect(autoMap(['column 1', 'column 2', 'column 3'], ['a', 'b'], true)).toEqual([
      'a',
      'b',
      null,
    ]);
    expect(autoMap(['column 1'], ['a'], false)).toEqual([null]);
  });
});

describe('new table naming', () => {
  it('sanitises column and file names', () => {
    expect(newTableColumns(csvPreview)).toEqual([
      { name: 'id', type: 'integer' },
      { name: 'full_name', type: 'text' },
      { name: 'joined_at', type: 'date' },
      { name: 'extra', type: 'text' },
    ]);
    expect(tableNameFromFile('People List.csv')).toBe('people_list');
  });
});

describe('buildImportJob', () => {
  it('maps csv columns by index and skips nulls', () => {
    const { job } = buildImportJob({
      jobId: 'j',
      connectionGen: 3,
      filePath: '/tmp/x.csv',
      schema: 'public',
      table: 'people',
      preview: csvPreview,
      targets: ['id', null, 'joined_at', null],
    });
    expect(job.columns).toEqual([
      { target: 'id', source: 0 },
      { target: 'joined_at', source: 2 },
    ]);
    expect(job.csv).toEqual(csvPreview.csv);
    expect(job.preStatements).toEqual([]);
  });
  it('creates the table first with only the mapped columns', () => {
    const { job, gateSql } = buildImportJob({
      jobId: 'j',
      connectionGen: 1,
      filePath: '/tmp/x.csv',
      schema: 'public',
      table: 'People',
      preview: csvPreview,
      targets: ['id', 'full_name', null, null],
      create: newTableColumns(csvPreview),
    });
    expect(job.preStatements).toHaveLength(1);
    expect(job.preStatements[0]).toContain('CREATE TABLE public."People"');
    expect(job.preStatements[0]).toContain('id integer');
    expect(job.preStatements[0]).not.toContain('joined_at');
    expect(gateSql).toContain('CREATE TABLE');
    expect(gateSql).toContain('INSERT INTO public."People" (id, full_name)');
  });
  it('json maps by key', () => {
    const p: ImportPreview = {
      ...csvPreview,
      format: 'json',
      csv: undefined,
      columns: ['a', 'b'],
      types: ['text', 'text'],
    };
    const { job } = buildImportJob({
      jobId: 'j',
      connectionGen: 1,
      filePath: '/x.json',
      schema: 's',
      table: 't',
      preview: p,
      targets: ['x', 'y'],
    });
    expect(job.columns).toEqual([
      { target: 'x', source: 'a' },
      { target: 'y', source: 'b' },
    ]);
    expect(job.csv).toBeUndefined();
  });
  it('rejects empty and duplicate mappings, and bad types', () => {
    const base = {
      jobId: 'j',
      connectionGen: 1,
      filePath: '/x',
      schema: 's',
      table: 't',
      preview: csvPreview,
    };
    expect(() => buildImportJob({ ...base, targets: [null, null, null, null] })).toThrow(
      /at least one/,
    );
    expect(() => buildImportJob({ ...base, targets: ['a', 'a', null, null] })).toThrow(/twice/);
    expect(() =>
      buildImportJob({
        ...base,
        targets: ['a', null, null, null],
        create: [
          { name: 'a', type: 'int); drop table x' },
          ...newTableColumns(csvPreview).slice(1),
        ],
      }),
    ).toThrow();
  });
  it('sql files need no mapping', () => {
    const p: ImportPreview = {
      ...csvPreview,
      format: 'sql',
      csv: undefined,
      columns: [],
      types: [],
      statements: ['select 1'],
    };
    const { job, gateSql } = buildImportJob({
      jobId: 'j',
      connectionGen: 1,
      filePath: '/x.sql',
      schema: 's',
      table: 't',
      preview: p,
      targets: [],
    });
    expect(job.columns).toEqual([]);
    expect(gateSql).toContain('select 1;');
    expect(describeImportSql(job, p)).toContain('one transaction');
  });
});

describe('formatBytes', () => {
  it('scales', () => {
    expect(formatBytes(10)).toBe('10 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
