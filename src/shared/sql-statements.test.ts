import { describe, expect, it } from 'vitest';
import { isSingleSqlStatement, splitSqlStatements } from './sql-statements';

describe('isSingleSqlStatement (U04)', () => {
  it('accepts a single statement with trailing semicolon', () => {
    expect(isSingleSqlStatement('SELECT 1;')).toBe(true);
    expect(splitSqlStatements('SELECT 1;')).toEqual(['SELECT 1']);
  });

  it('rejects stacked statements used to bypass the keyword pre-filter', () => {
    expect(isSingleSqlStatement('SELECT 1; DROP TABLE accounts')).toBe(false);
    expect(splitSqlStatements('SELECT 1; DROP TABLE accounts')).toEqual([
      'SELECT 1',
      'DROP TABLE accounts',
    ]);
  });

  it('does not split on semicolons inside quotes', () => {
    expect(isSingleSqlStatement("SELECT 'a;b' AS x")).toBe(true);
  });
});
