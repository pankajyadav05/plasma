import { describe, expect, it } from 'vitest';
import {
  mysqlAuxReadViolation,
  mysqlReadOnlyEscapeReason,
  mysqlSkeleton,
} from './mysql-readonly-sql';

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
    // MySQL does not nest comments: the first star-slash ends it
    'START TRANSACTION /* /* */ READ WRITE /* */',
    'START TRANSACTION # note\n READ WRITE',
    'START TRANSACTION -- note\n READ WRITE',
    "SELECT '\\'' ; START TRANSACTION READ WRITE",
    'SET /* x */ @@session.tx_read_only = 0',
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
    'SELECT @@transaction_read_only',
    'SELECT @@tx_read_only',
    "SELECT 'a' /* START TRANSACTION READ WRITE */",
    '-- START TRANSACTION READ WRITE\nSELECT 1',
    'SELECT `read write` FROM t',
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
    '/*!50000 SELECT 1 */',
    "SELECT 1 /* /* */ INTO OUTFILE '/tmp/x' /* */",
    "SELECT '\\'' INTO OUTFILE '/tmp/x'",
    "SELECT 1 # c\n INTO DUMPFILE '/tmp/x'",
    "SELECT 1 -- c\n INTO OUTFILE '/tmp/x'",
    'SELECT "\\"" INTO OUTFILE \'/tmp/x\'',
    '',
  ];
  for (const sql of refused) {
    it(`refuses ${JSON.stringify(sql)}`, () => {
      expect(mysqlAuxReadViolation(sql)).not.toBeNull();
    });
  }
});

describe('mysqlSkeleton', () => {
  it('lexes comments, strings and identifiers the MySQL way', () => {
    expect(mysqlSkeleton('SELECT /* a /* b */ 1').text).toBe('select 1');
    expect(mysqlSkeleton('SELECT 1 # x\n, 2').text).toBe('select 1 , 2');
    expect(mysqlSkeleton('SELECT 1 -- x\n, 2').text).toBe('select 1 , 2');
    // "--" without a following blank is not a comment in MySQL: 1 - (-2)
    expect(mysqlSkeleton('SELECT 1--2').text).toBe('select 1--2');
    expect(mysqlSkeleton('SELECT \'a\\\'b\', "c""d", `e``f`').text).toBe("select '', '', `_`");
    expect(mysqlSkeleton('SELECT /*! 1 */').executableComment).toBe(true);
    expect(mysqlSkeleton('SELECT /*M!100 1 */').executableComment).toBe(true);
    expect(mysqlSkeleton('SELECT /* 1 */').executableComment).toBe(false);
  });
});
