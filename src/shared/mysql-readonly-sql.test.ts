import { describe, expect, it } from 'vitest';
import {
  mysqlAuxReadViolation,
  mysqlReadOnlyEscapeReason,
  unwrapExecutableComments,
} from './mysql-readonly-sql';

describe('unwrapExecutableComments', () => {
  it('exposes what MySQL and MariaDB run inside versioned comments', () => {
    expect(unwrapExecutableComments('SELECT 1 /*!50000 , 2 */')).toMatch(/SELECT 1\s+, 2/);
    expect(unwrapExecutableComments('/*M!100000 SET x = 1 */')).toMatch(/SET x = 1/);
    expect(unwrapExecutableComments('/*!START TRANSACTION READ WRITE*/')).toMatch(
      /START TRANSACTION READ WRITE/,
    );
  });

  it('leaves ordinary comments alone', () => {
    expect(unwrapExecutableComments('/* note */ SELECT 1')).toBe('/* note */ SELECT 1');
  });
});

describe('mysqlReadOnlyEscapeReason', () => {
  const refused = [
    'START TRANSACTION READ WRITE',
    'start   transaction\nread\twrite',
    'SET TRANSACTION READ WRITE',
    'SET SESSION TRANSACTION READ WRITE',
    'SET GLOBAL TRANSACTION READ WRITE',
    'SET SESSION tx_read_only = 0',
    'SET @@session.transaction_read_only = OFF',
    'SET @@tx_read_only=0',
    '/*!START TRANSACTION READ WRITE*/',
    '/*!50000 SET SESSION tx_read_only = 0 */',
    '/*M!100000 START TRANSACTION READ WRITE */',
    'PREPARE p FROM "START TRANSACTION READ WRITE"',
    'EXECUTE p',
    'prepare\np from @s',
  ];
  for (const sql of refused) {
    it(`refuses ${JSON.stringify(sql)}`, () => {
      expect(mysqlReadOnlyEscapeReason(sql)).not.toBeNull();
    });
  }

  const fine = [
    'SELECT 1',
    "SELECT 'start transaction read write'",
    '-- read write\nSELECT 1',
    '/* tx_read_only */ SELECT 1',
    'START TRANSACTION READ ONLY',
    'START TRANSACTION',
    'BEGIN',
    'COMMIT',
    'SELECT @@session.transaction_isolation',
    'SET SESSION TRANSACTION READ ONLY',
    'INSERT INTO t (prepared) VALUES (1)',
  ];
  for (const sql of fine) {
    it(`lets ${JSON.stringify(sql)} through`, () => {
      expect(mysqlReadOnlyEscapeReason(sql)).toBeNull();
    });
  }
});

describe('mysqlAuxReadViolation', () => {
  const reads = [
    'SELECT 1',
    '(SELECT 1) UNION (SELECT 2)',
    'WITH c AS (SELECT 1 AS n) SELECT n FROM c',
    'SHOW TABLES',
    'DESCRIBE users',
    'DESC users',
    'EXPLAIN SELECT 1',
    'EXPLAIN FORMAT=JSON DELETE FROM users',
    'VALUES ROW(1)',
    'TABLE users',
    '-- note\nSELECT 1',
    '/* c */ select 1',
  ];
  for (const sql of reads) {
    it(`allows ${JSON.stringify(sql)}`, () => {
      expect(mysqlAuxReadViolation(sql)).toBeNull();
    });
  }

  const refused = [
    'INSERT INTO t VALUES (1)',
    'UPDATE t SET a = 1',
    'DELETE FROM t',
    'TRUNCATE TABLE t',
    'CREATE TABLE t (a INT)',
    'DROP TABLE t',
    'ALTER TABLE t ADD c INT',
    'CALL p()',
    'SET @a = 1',
    'SET SESSION TRANSACTION READ WRITE',
    'START TRANSACTION READ WRITE',
    'COMMIT',
    'ANALYZE FORMAT=JSON DELETE FROM t',
    'ANALYZE TABLE t',
    'LOCK TABLES t WRITE',
    'LOAD DATA INFILE "/x" INTO TABLE t',
    'HANDLER t OPEN',
    'PREPARE p FROM "DELETE FROM t"',
    'EXECUTE p',
    'USE other',
    "SELECT 1 INTO OUTFILE '/tmp/x'",
    "SELECT * FROM t INTO   DUMPFILE '/tmp/x'",
    '/*!DELETE FROM t*/',
    '',
  ];
  for (const sql of refused) {
    it(`refuses ${JSON.stringify(sql)}`, () => {
      expect(mysqlAuxReadViolation(sql)).not.toBeNull();
    });
  }
});
