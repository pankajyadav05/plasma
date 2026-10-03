import { describe, expect, it } from 'vitest';
import { sqlReadOnlyEscapeReason } from './sql-readonly';

describe('sqlReadOnlyEscapeReason', () => {
  it('lets ordinary reads and writes through (writes are the server / file mode job)', () => {
    expect(sqlReadOnlyEscapeReason('sqlite', 'SELECT 1')).toBeNull();
    expect(sqlReadOnlyEscapeReason('mysql', 'SELECT * FROM t')).toBeNull();
    expect(sqlReadOnlyEscapeReason('mysql', "SELECT 'tx_read_only'")).toBeNull();
  });

  it('blocks MySQL attempts to leave read-only', () => {
    for (const sql of [
      'SET SESSION TRANSACTION READ WRITE',
      'SET TRANSACTION READ WRITE',
      'SET @@session.tx_read_only = 0',
      'SET GLOBAL read_only = 0',
      'START TRANSACTION READ WRITE',
      'SET SESSION transaction_read_only = OFF',
    ]) {
      expect(sqlReadOnlyEscapeReason('mysql', sql), sql).not.toBeNull();
    }
  });

  it('blocks SQLite PRAGMAs and ATTACH that undo read-only', () => {
    for (const sql of [
      'PRAGMA query_only = 0',
      'pragma main.query_only=OFF',
      'PRAGMA writable_schema = 1',
      "ATTACH DATABASE '/tmp/x.db' AS x",
      "SELECT load_extension('x')",
    ]) {
      expect(sqlReadOnlyEscapeReason('sqlite', sql), sql).not.toBeNull();
    }
    expect(sqlReadOnlyEscapeReason('sqlite', 'PRAGMA table_info(t)')).toBeNull();
  });

  it('still applies the shared Postgres screen', () => {
    expect(
      sqlReadOnlyEscapeReason('postgres', 'SET default_transaction_read_only = off'),
    ).not.toBeNull();
  });
});
