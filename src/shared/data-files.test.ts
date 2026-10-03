import { describe, expect, it } from 'vitest';
import {
  attachAlias,
  createViewSql,
  dataFileKind,
  dataFilePathProblem,
  dataFileSessionConfig,
  dataFileSessionId,
  dataFileStem,
  isDataFileSession,
  viewNamesFor,
} from './data-files';

describe('dataFileKind', () => {
  it('recognises the supported formats, compressed or not', () => {
    expect(dataFileKind('/a/b.csv')).toBe('csv');
    expect(dataFileKind('/a/B.CSV.GZ')).toBe('csv');
    expect(dataFileKind('/a/b.tsv')).toBe('tsv');
    expect(dataFileKind('/a/b.parquet')).toBe('parquet');
    expect(dataFileKind('/a/b.json')).toBe('json');
    expect(dataFileKind('/a/b.jsonl')).toBe('ndjson');
    expect(dataFileKind('/a/b.ndjson.gz')).toBe('ndjson');
    expect(dataFileKind('C:\\data\\warehouse.duckdb')).toBe('duckdb');
  });

  it('rejects everything else (XLSX needs an extension that is not bundled)', () => {
    for (const p of ['/a/b.xlsx', '/a/b.txt', '/a/b', '/a/b.parquet.gz', '/a/.csv.exe']) {
      expect(dataFileKind(p), p).toBeNull();
    }
  });
});

describe('dataFilePathProblem', () => {
  it('refuses glob characters, NULs and unsupported types', () => {
    expect(dataFilePathProblem('/a/b.csv')).toBeNull();
    expect(dataFilePathProblem('/a/b[1].csv')).toMatch(/patterns/);
    expect(dataFilePathProblem('/a/*.csv')).toMatch(/patterns/);
    expect(dataFilePathProblem('/a/b?.csv')).toMatch(/patterns/);
    expect(dataFilePathProblem('/a/b.csv\0.png')).toMatch(/not valid/);
    expect(dataFilePathProblem('/a/b.xlsx')).toMatch(/Unsupported/);
  });
});

describe('view names', () => {
  it('names a view after the file and keeps it readable', () => {
    expect(dataFileStem('/x/Sales 2024.csv')).toBe('Sales_2024');
    expect(dataFileStem('/x/events.ndjson.gz')).toBe('events');
    expect(dataFileStem('/x/ünï-cødé.parquet')).toBe('n_c_d');
    expect(dataFileStem('/x/@@@.csv')).toBe('data');
  });

  it('dedupes clashes case-insensitively and avoids reserved names', () => {
    expect(viewNamesFor(['/a/t.csv', '/b/T.parquet', '/c/t.json'])).toEqual(['t', 'T_2', 't_3']);
    expect(viewNamesFor(['/a/main.csv'], ['MAIN'])).toEqual(['main_2']);
  });
});

describe('createViewSql', () => {
  it('uses the reader for each kind and escapes quotes in the path', () => {
    expect(createViewSql('t', "/a/o'k.csv", 'csv')).toBe(
      `CREATE VIEW "t" AS SELECT * FROM read_csv_auto('/a/o''k.csv')`,
    );
    expect(createViewSql('t', '/a/b.tsv', 'tsv')).toContain(`delim = '\\t'`);
    expect(createViewSql('t', '/a/b.parquet', 'parquet')).toContain('read_parquet(');
    expect(createViewSql('t', '/a/b.json', 'json')).toContain('read_json_auto(');
    expect(createViewSql('t', '/a/b.ndjson', 'ndjson')).toContain('newline_delimited');
    expect(createViewSql('a"b', '/a/b.csv', 'csv')).toContain('"a""b"');
    expect(() => createViewSql('t', '/a/b.duckdb', 'duckdb')).toThrow();
  });
});

describe('dataFileSessionConfig', () => {
  it('builds an in-memory session over the files', () => {
    const c = dataFileSessionConfig(['/a/x.csv', '/a/y.parquet'], [], 'duckdb-1');
    expect(c).toMatchObject({
      id: 'duckdb-1',
      engine: 'duckdb',
      database: ':memory:',
      name: 'x.csv +1',
      duckdb: { files: ['/a/x.csv', '/a/y.parquet'] },
    });
    expect(isDataFileSession(c)).toBe(true);
    expect(isDataFileSession({ engine: 'duckdb', id: 'a-saved-uuid' })).toBe(false);
  });

  it('makes a .duckdb file the database and keeps attach ids', () => {
    const c = dataFileSessionConfig(['/a/x.csv', '/a/w.duckdb'], ['pg-1'], 'duckdb-2');
    expect(c.database).toBe('/a/w.duckdb');
    expect(c.duckdb).toEqual({ files: ['/a/x.csv'], attachConnectionIds: ['pg-1'] });
  });

  it('derives a stable id from the files, whatever their order', () => {
    expect(dataFileSessionId(['/a/x.csv', '/a/y.csv'])).toBe(
      dataFileSessionId(['/a/y.csv', '/a/x.csv']),
    );
    expect(dataFileSessionId(['/a/x.csv'])).not.toBe(dataFileSessionId(['/a/y.csv']));
    expect(dataFileSessionId(['/a/x.csv'], ['pg-1'])).not.toBe(dataFileSessionId(['/a/x.csv']));
    expect(dataFileSessionId(['/a/x.csv'])).toMatch(/^duckdb-[0-9a-z]+$/);
    expect(dataFileSessionConfig(['/a/x.csv']).id).toBe(dataFileSessionId(['/a/x.csv']));
  });

  it('aliases attached Postgres connections without clashes', () => {
    expect(attachAlias('Prod DB')).toBe('pg_Prod_DB');
    expect(attachAlias('Prod DB', ['pg_prod_db'])).toBe('pg_Prod_DB_2');
  });
});
