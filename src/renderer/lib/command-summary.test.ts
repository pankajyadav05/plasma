import { describe, expect, it } from 'vitest';
import { commandDetail, commandTitle } from './command-summary';

describe('commandTitle', () => {
  it('names the object kind for DDL', () => {
    expect(commandTitle('CREATE', 'create or replace view v as select 1')).toBe('CREATE VIEW');
    expect(commandTitle('CREATE', '-- note\n/* x */\nCREATE MATERIALIZED VIEW mv AS SELECT 1')).toBe(
      'CREATE MATERIALIZED VIEW',
    );
    expect(commandTitle('DROP', 'drop table if exists t')).toBe('DROP TABLE');
    expect(commandTitle('CREATE', 'CREATE UNIQUE INDEX i ON t(a)')).toBe('CREATE UNIQUE INDEX');
  });

  it('falls back to the tag', () => {
    expect(commandTitle('INSERT', 'insert into t values (1)')).toBe('INSERT');
    expect(commandTitle(undefined)).toBe('OK');
    expect(commandTitle('CREATE', 'CREATE FOO bar')).toBe('CREATE');
  });
});

describe('commandDetail', () => {
  it('shows rows only where the count is meaningful', () => {
    expect(commandDetail('CREATE', 0)).toBe('Query executed successfully');
    expect(commandDetail('SET', 0)).toBe('Query executed successfully');
    expect(commandDetail('UPDATE', 3)).toBe('3 rows affected');
    expect(commandDetail('DELETE', 1)).toBe('1 row affected');
    expect(commandDetail('SELECT', 1200)).toBe('1,200 rows');
  });
});
