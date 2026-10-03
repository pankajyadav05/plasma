import { describe, expect, it } from 'vitest';
import { clickhouseMutation } from './clickhouse-mutation';

describe('clickhouseMutation', () => {
  it('flags ALTER … UPDATE / DELETE, lightweight DELETE FROM and UPDATE', () => {
    expect(clickhouseMutation('ALTER TABLE db.t UPDATE a = 1 WHERE id = 2')).toBe('alter-update');
    expect(clickhouseMutation('alter table t on cluster c update a = 1 where 1')).toBe(
      'alter-update',
    );
    expect(clickhouseMutation('ALTER TABLE t DELETE WHERE ts < now()')).toBe('alter-delete');
    expect(clickhouseMutation('DELETE FROM t WHERE id = 1')).toBe('delete');
    expect(clickhouseMutation('UPDATE t SET a = 1 WHERE id = 1')).toBe('update');
  });

  it('finds a mutation in the middle of a script', () => {
    expect(clickhouseMutation('SELECT 1; ALTER TABLE t UPDATE a = 1 WHERE 1;')).toBe(
      'alter-update',
    );
  });

  it('leaves reads, inserts and other ALTERs alone, and ignores strings and comments', () => {
    for (const sql of [
      'SELECT * FROM t',
      "INSERT INTO t VALUES (1, 'ALTER TABLE x UPDATE y')",
      'ALTER TABLE t ADD COLUMN c UInt8',
      "SELECT 'DELETE FROM t'",
      '-- ALTER TABLE t UPDATE a = 1\nSELECT 1',
      'SET max_threads = 1',
    ]) {
      expect(clickhouseMutation(sql), sql).toBeNull();
    }
  });
});
