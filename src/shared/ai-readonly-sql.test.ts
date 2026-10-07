import { describe, expect, it } from 'vitest';
import { isAgentReadSql } from './ai-readonly-sql';

describe('isAgentReadSql: calls a read-only session does not stop (MCP run_query runs without a click)', () => {
  const refused = [
    // MySQL / MariaDB
    "SELECT LOAD_FILE('/etc/mysql/debian.cnf')",
    "select load_file ('/etc/passwd')",
    'SELECT SLEEP(30)',
    'SELECT BENCHMARK(100000000, MD5(1))',
    "SELECT GET_LOCK('x', 10)",
    "SELECT RELEASE_LOCK('x')",
    'SELECT RELEASE_ALL_LOCKS()',
    "SELECT IS_FREE_LOCK('x')",
    "SELECT IS_USED_LOCK('x')",
    "SELECT MASTER_POS_WAIT('bin.000001', 4)",
    "SELECT SOURCE_POS_WAIT('bin.000001', 4)",
    "SELECT * FROM t INTO OUTFILE '/tmp/x'",
    "SELECT * FROM t INTO DUMPFILE '/tmp/x'",
    'SELECT `sleep`(1)',
    // Postgres
    'SELECT pg_sleep(10)',
    "SELECT pg_sleep_for(interval '1 min')",
    "SELECT pg_read_file('/etc/passwd')",
    "SELECT pg_read_binary_file('/etc/passwd')",
    "SELECT pg_ls_dir('/')",
    "SELECT lo_import('/etc/passwd')",
    "SELECT lo_export(1, '/tmp/x')",
    "SELECT dblink('host=x', 'select 1')",
    "SELECT dblink_connect('host=x')",
    'SELECT pg_advisory_lock(1)',
    'SELECT pg_try_advisory_lock(1)',
    'SELECT pg_advisory_xact_lock(1)',
  ];
  for (const sql of refused) {
    it(`refuses ${sql}`, () => expect(isAgentReadSql(sql)).toBe(false));
  }

  it('still allows ordinary reads, including columns and aliases that merely contain those words', () => {
    for (const sql of [
      'SELECT id, sleep_hours FROM people',
      'SELECT benchmark_score FROM runs',
      'SELECT lock_name FROM locks',
      'SELECT * FROM load_files_log',
      'WITH x AS (SELECT 1) SELECT * FROM x',
      'EXPLAIN SELECT * FROM orders',
    ]) {
      expect(isAgentReadSql(sql), sql).toBe(true);
    }
  });
});
