import { describe, expect, it } from 'vitest';
import { pgReadOnlyEscapeReason } from './pg-readonly-sql';

describe('pgReadOnlyEscapeReason (SC-02)', () => {
  it.each([
    'SET default_transaction_read_only = off',
    'set transaction_read_only to off',
    'BEGIN READ WRITE',
    'SET TRANSACTION READ WRITE',
    'SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE',
    'START TRANSACTION  read\n write',
    "SELECT set_config('x', 'y', false)",
    'RESET ALL',
    'reset  all',
    'DISCARD ALL',
    'SET "default_transaction_read_only" = off',
    'SET SESSION "work_mem" = 1',
    "DO $$ BEGIN EXECUTE 'set x'; END $$",
    "DO $$ BEGIN PERFORM set_config('a','b',false); END $$",
  ])('refuses %s', (sql) => {
    expect(pgReadOnlyEscapeReason(sql)).not.toBeNull();
  });

  it.each([
    'SELECT * FROM users',
    "SELECT 'read write' AS s",
    'SELECT 1 -- read write',
    'RESET ROLE',
    'SET ROLE analyst',
    'SET search_path = public',
    'DISCARD PLANS',
    'DO $$ BEGIN PERFORM 1; END $$',
    'BEGIN READ ONLY',
    'SHOW transaction_isolation',
  ])('allows %s', (sql) => {
    expect(pgReadOnlyEscapeReason(sql)).toBeNull();
  });
});
