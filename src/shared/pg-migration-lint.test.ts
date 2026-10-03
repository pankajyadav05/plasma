import { describe, expect, it } from 'vitest';
import {
  LINT_RULES,
  LINT_RULE_IDS,
  type LintOptions,
  type LintRuleId,
  applyLintFix,
  isRewriteFreeTypeChange,
  lintMigration,
  normalizePgType,
  worstSeverity,
} from './pg-migration-lint';

const ids = (sql: string, opts?: LintOptions) =>
  lintMigration(sql, {
    ...opts,
    muted: [...(opts?.muted ?? []), 'missing-lock-timeout'],
  }).findings.map((f) => f.ruleId);
const has = (sql: string, id: LintRuleId, opts?: LintOptions) =>
  lintMigration(sql, opts).findings.some((f) => f.ruleId === id);

describe('rule catalogue', () => {
  it('every rule has severity, message, alternative and docs link', () => {
    for (const id of LINT_RULE_IDS) {
      const r = LINT_RULES[id];
      expect(r.id).toBe(id);
      expect(['error', 'warn', 'info']).toContain(r.severity);
      expect(r.message.length).toBeGreaterThan(10);
      expect(r.alternative.length).toBeGreaterThan(10);
      expect(r.docs).toMatch(/^https:\/\//);
    }
  });
});

describe('create-index-non-concurrent', () => {
  it('flags CREATE INDEX on an existing table and offers CONCURRENTLY', () => {
    const sql = 'CREATE INDEX idx_a ON orders (customer_id);';
    const f = lintMigration(sql).findings.find((x) => x.ruleId === 'create-index-non-concurrent');
    expect(f?.severity).toBe('error');
    expect(f?.target).toBe('orders');
    const edit = f?.fix?.edits[0];
    expect(edit).toBeDefined();
    const fixed = sql.slice(0, edit!.start) + edit!.text + sql.slice(edit!.end);
    expect(fixed).toBe('CREATE INDEX CONCURRENTLY idx_a ON orders (customer_id);');
  });
  it('accepts CONCURRENTLY', () => {
    expect(ids('CREATE INDEX CONCURRENTLY idx_a ON orders (customer_id)')).toEqual([]);
  });
  it('accepts an index on a table created in the same script', () => {
    expect(ids('CREATE TABLE t (a int); CREATE INDEX i ON t (a);')).toEqual([]);
  });
  it('skips tables known to be small', () => {
    expect(ids('CREATE INDEX i ON t (a)', { tableRows: () => 50 })).toEqual([]);
    expect(ids('CREATE INDEX i ON t (a)', { tableRows: () => 5_000_000 })).toContain(
      'create-index-non-concurrent',
    );
  });
});

describe('create-unique-index-non-concurrent', () => {
  it('flags CREATE UNIQUE INDEX', () => {
    expect(ids('CREATE UNIQUE INDEX u ON users (email)')).toEqual([
      'create-unique-index-non-concurrent',
    ]);
  });
  it('flags ADD CONSTRAINT UNIQUE without USING INDEX', () => {
    expect(ids('ALTER TABLE users ADD CONSTRAINT u UNIQUE (email)')).toEqual([
      'create-unique-index-non-concurrent',
    ]);
  });
  it('accepts UNIQUE USING INDEX and CONCURRENTLY', () => {
    expect(ids('ALTER TABLE users ADD CONSTRAINT u UNIQUE USING INDEX u_idx')).toEqual([]);
    expect(ids('CREATE UNIQUE INDEX CONCURRENTLY u ON users (email)')).toEqual([]);
  });
});

describe('drop-index-non-concurrent', () => {
  it('flags DROP INDEX with a CONCURRENTLY fix', () => {
    const sql = 'DROP INDEX idx_a';
    const f = lintMigration(sql).findings.find((x) => x.ruleId === 'drop-index-non-concurrent');
    expect(f).toBeDefined();
    const e = f!.fix!.edits[0]!;
    expect(sql.slice(0, e.start) + e.text + sql.slice(e.end)).toBe('DROP INDEX CONCURRENTLY idx_a');
  });
  it('accepts CONCURRENTLY', () => {
    expect(ids('DROP INDEX CONCURRENTLY IF EXISTS idx_a')).toEqual([]);
  });
  it('offers no fix for a multi-index drop', () => {
    const f = lintMigration('DROP INDEX a, b').findings.find(
      (x) => x.ruleId === 'drop-index-non-concurrent',
    );
    expect(f?.fix).toBeUndefined();
  });
});

describe('add-column-volatile-default', () => {
  it('flags volatile defaults', () => {
    expect(ids('ALTER TABLE t ADD COLUMN id uuid DEFAULT gen_random_uuid()')).toEqual([
      'add-column-volatile-default',
    ]);
    expect(ids('ALTER TABLE t ADD COLUMN r float DEFAULT random()')).toEqual([
      'add-column-volatile-default',
    ]);
  });
  it('flags serial, identity and stored generated columns', () => {
    expect(ids('ALTER TABLE t ADD COLUMN n bigserial')).toEqual(['add-column-volatile-default']);
    expect(ids('ALTER TABLE t ADD COLUMN n int GENERATED ALWAYS AS IDENTITY')).toEqual([
      'add-column-volatile-default',
    ]);
    expect(ids('ALTER TABLE t ADD COLUMN n int GENERATED ALWAYS AS (a * 2) STORED')).toEqual([
      'add-column-volatile-default',
    ]);
  });
  it('allows constant and stable defaults on PG 11+ but not before', () => {
    expect(ids("ALTER TABLE t ADD COLUMN s text DEFAULT 'x' NOT NULL")).toEqual([]);
    expect(ids('ALTER TABLE t ADD COLUMN ts timestamptz DEFAULT now()')).toEqual([]);
    expect(ids("ALTER TABLE t ADD COLUMN s text DEFAULT 'x'", { pgVersion: 10 })).toEqual([
      'add-column-volatile-default',
    ]);
  });
});

describe('add-column-not-null-no-default', () => {
  it('flags NOT NULL without default', () => {
    expect(ids('ALTER TABLE t ADD COLUMN a int NOT NULL')).toEqual([
      'add-column-not-null-no-default',
    ]);
  });
  it('accepts NOT NULL with a default, and nullable columns', () => {
    expect(ids('ALTER TABLE t ADD COLUMN a int NOT NULL DEFAULT 0')).toEqual([]);
    expect(ids('ALTER TABLE t ADD COLUMN a int')).toEqual([]);
  });
  it('ignores a table created in this script', () => {
    expect(ids('CREATE TABLE t (id int); ALTER TABLE t ADD COLUMN a int NOT NULL;')).toEqual([]);
  });
});

describe('set-not-null', () => {
  it('flags SET NOT NULL', () => {
    expect(ids('ALTER TABLE t ALTER COLUMN a SET NOT NULL')).toEqual(['set-not-null']);
    expect(LINT_RULES['set-not-null'].alternative).toMatch(/NOT VALID/);
  });
  it('skips known small tables', () => {
    expect(ids('ALTER TABLE t ALTER COLUMN a SET NOT NULL', { tableRows: () => 10 })).toEqual([]);
  });
  it('does not flag DROP NOT NULL or SET DEFAULT', () => {
    expect(ids('ALTER TABLE t ALTER COLUMN a DROP NOT NULL')).toEqual([]);
    expect(ids('ALTER TABLE t ALTER COLUMN a SET DEFAULT 1')).toEqual([]);
  });
});

describe('change-column-type', () => {
  const col = (t: string) => () => t;
  it('flags a rewriting change when the old type is known', () => {
    expect(ids('ALTER TABLE t ALTER COLUMN a TYPE bigint', { columnType: col('integer') })).toEqual(
      ['change-column-type'],
    );
    expect(
      ids('ALTER TABLE t ALTER COLUMN a TYPE varchar(5)', {
        columnType: col('character varying(20)'),
      }),
    ).toEqual(['change-column-type']);
  });
  it('accepts varchar(n) -> varchar(m>n) and varchar -> text', () => {
    expect(
      ids('ALTER TABLE t ALTER COLUMN a TYPE varchar(50)', {
        columnType: col('character varying(20)'),
      }),
    ).toEqual([]);
    expect(
      ids('ALTER TABLE t ALTER COLUMN a TYPE text', { columnType: col('character varying(20)') }),
    ).toEqual([]);
  });
  it('USING forces a rewrite; unknown old type to text is only info', () => {
    expect(
      ids('ALTER TABLE t ALTER COLUMN a TYPE text USING a::text', {
        columnType: col('varchar(3)'),
      }),
    ).toEqual(['change-column-type']);
    const f = lintMigration('ALTER TABLE t ALTER COLUMN a SET DATA TYPE text').findings.find(
      (x) => x.ruleId === 'change-column-type',
    );
    expect(f?.severity).toBe('info');
    expect(
      lintMigration('ALTER TABLE t ALTER COLUMN a TYPE bigint').findings.find(
        (x) => x.ruleId === 'change-column-type',
      )?.severity,
    ).toBe('error');
  });
  it('classifies casts', () => {
    expect(isRewriteFreeTypeChange('varchar(10)', 'varchar(10)')).toBe(true);
    expect(isRewriteFreeTypeChange('varchar(10)', 'character varying(255)')).toBe(true);
    expect(isRewriteFreeTypeChange('varchar(255)', 'varchar(10)')).toBe(false);
    expect(isRewriteFreeTypeChange('varchar', 'text')).toBe(true);
    expect(isRewriteFreeTypeChange('text', 'varchar(10)')).toBe(false);
    expect(isRewriteFreeTypeChange('numeric(10,2)', 'numeric(12,2)')).toBe(true);
    expect(isRewriteFreeTypeChange('numeric(10,2)', 'numeric(12,4)')).toBe(false);
    expect(isRewriteFreeTypeChange('int', 'bigint')).toBe(false);
    expect(isRewriteFreeTypeChange('timestamp', 'timestamptz')).toBe(false);
    expect(normalizePgType('timestamp(3) with time zone').base).toBe('timestamptz');
  });
});

describe('add-foreign-key-not-valid + fk-missing-index', () => {
  const fk =
    'ALTER TABLE orders ADD CONSTRAINT fk_c FOREIGN KEY (customer_id) REFERENCES customers (id)';
  it('flags FK without NOT VALID, with a NOT VALID fix', () => {
    const f = lintMigration(fk).findings.find((x) => x.ruleId === 'add-foreign-key-not-valid');
    expect(f).toBeDefined();
    const e = f!.fix!.edits[0]!;
    expect(fk.slice(0, e.start) + e.text + fk.slice(e.end)).toBe(`${fk} NOT VALID`);
  });
  it('accepts NOT VALID', () => {
    expect(has(`${fk} NOT VALID`, 'add-foreign-key-not-valid')).toBe(false);
  });
  it('reports a missing FK index: info unknown, warn when live says none, silent when present', () => {
    const sev = (o?: LintOptions) =>
      lintMigration(fk, o).findings.find((x) => x.ruleId === 'fk-missing-index')?.severity;
    expect(sev()).toBe('info');
    expect(sev({ hasIndex: () => false })).toBe('warn');
    expect(sev({ hasIndex: () => true })).toBeUndefined();
    expect(
      has(`CREATE INDEX CONCURRENTLY i ON orders (customer_id, x); ${fk}`, 'fk-missing-index'),
    ).toBe(false);
  });
});

describe('add-check-not-valid', () => {
  it('flags CHECK without NOT VALID with a fix', () => {
    const sql = 'ALTER TABLE t ADD CONSTRAINT c CHECK (a > 0)';
    const f = lintMigration(sql).findings.find((x) => x.ruleId === 'add-check-not-valid');
    expect(f).toBeDefined();
    expect(f!.fix!.edits[0]!.text).toBe(' NOT VALID');
    expect(f!.fix!.edits[0]!.start).toBe(sql.length);
  });
  it('accepts NOT VALID', () => {
    expect(ids('ALTER TABLE t ADD CONSTRAINT c CHECK (a > 0) NOT VALID')).toEqual([]);
  });
  it('handles unnamed CHECK and multiple actions', () => {
    expect(ids('ALTER TABLE t ADD CHECK (a > 0), ADD CHECK (b > 0) NOT VALID')).toEqual([
      'add-check-not-valid',
    ]);
  });
});

describe('rename-column / rename-table', () => {
  it('flags RENAME COLUMN with and without COLUMN', () => {
    expect(ids('ALTER TABLE t RENAME COLUMN a TO b')).toEqual(['rename-column']);
    expect(ids('ALTER TABLE t RENAME a TO b')).toEqual(['rename-column']);
  });
  it('flags RENAME TO', () => {
    expect(ids('ALTER TABLE t RENAME TO t2')).toEqual(['rename-table']);
  });
  it('ignores RENAME CONSTRAINT and fresh tables', () => {
    expect(ids('ALTER TABLE t RENAME CONSTRAINT a TO b')).toEqual([]);
    expect(ids('CREATE TABLE t (a int); ALTER TABLE t RENAME COLUMN a TO b')).toEqual([]);
  });
});

describe('drop-column / drop-table', () => {
  it('flags DROP COLUMN', () => {
    expect(ids('ALTER TABLE t DROP COLUMN a')).toEqual(['drop-column']);
    expect(ids('ALTER TABLE t DROP a')).toEqual(['drop-column']);
  });
  it('flags DROP TABLE, even IF EXISTS with several', () => {
    expect(ids('DROP TABLE IF EXISTS a, b CASCADE')).toEqual(['drop-table']);
  });
  it('ignores dropping defaults / not null and a table created here', () => {
    expect(ids('ALTER TABLE t ALTER COLUMN a DROP DEFAULT')).toEqual([]);
    expect(ids('CREATE TABLE x (a int); DROP TABLE x')).toEqual([]);
  });
});

describe('vacuum-full-cluster', () => {
  it('flags VACUUM FULL and VACUUM (FULL)', () => {
    expect(ids('VACUUM FULL orders')).toEqual(['vacuum-full-cluster']);
    expect(ids('VACUUM (FULL, ANALYZE) orders')).toEqual(['vacuum-full-cluster']);
  });
  it('flags CLUSTER', () => {
    expect(ids('CLUSTER orders USING orders_pkey')).toEqual(['vacuum-full-cluster']);
  });
  it('accepts plain VACUUM / ANALYZE', () => {
    expect(ids('VACUUM ANALYZE orders')).toEqual([]);
    expect(ids('VACUUM (ANALYZE) orders')).toEqual([]);
  });
});

describe('truncate', () => {
  it('flags TRUNCATE', () => {
    expect(ids('TRUNCATE orders')).toEqual(['truncate']);
    expect(ids('TRUNCATE TABLE a, b RESTART IDENTITY')).toEqual(['truncate']);
  });
  it('mentions CASCADE', () => {
    const f = lintMigration('TRUNCATE a CASCADE').findings.find((x) => x.ruleId === 'truncate');
    expect(f?.message).toMatch(/CASCADE/);
  });
  it('does not flag DELETE', () => {
    expect(ids('DELETE FROM orders WHERE id = 1')).toEqual([]);
  });
});

describe('change-primary-key', () => {
  it('flags ADD PRIMARY KEY', () => {
    expect(ids('ALTER TABLE t ADD PRIMARY KEY (id)')).toEqual(['change-primary-key']);
  });
  it('flags DROP CONSTRAINT *_pkey', () => {
    expect(ids('ALTER TABLE t DROP CONSTRAINT t_pkey')).toEqual(['change-primary-key']);
  });
  it('downgrades USING INDEX; ignores other constraint drops', () => {
    const f = lintMigration(
      'ALTER TABLE t ADD CONSTRAINT t_pkey PRIMARY KEY USING INDEX t_idx',
    ).findings.find((x) => x.ruleId === 'change-primary-key');
    expect(f?.severity).toBe('warn');
    expect(ids('ALTER TABLE t DROP CONSTRAINT t_fk')).toEqual([]);
  });
});

describe('missing-lock-timeout', () => {
  it('suggests SET lock_timeout once for locking DDL', () => {
    const r = lintMigration('ALTER TABLE a DROP COLUMN x; ALTER TABLE b DROP COLUMN y;').findings;
    const hits = r.filter((f) => f.ruleId === 'missing-lock-timeout');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.fix!.edits[0]!.text).toContain("lock_timeout = '5s'");
  });
  it('is satisfied by SET / SET LOCAL lock_timeout', () => {
    expect(
      has("SET lock_timeout = '3s'; ALTER TABLE a DROP COLUMN x", 'missing-lock-timeout'),
    ).toBe(false);
    expect(has("SET LOCAL lock_timeout TO '3s'; DROP TABLE a", 'missing-lock-timeout')).toBe(false);
  });
  it('is not raised for non-locking scripts, or lock_timeout = 0', () => {
    expect(has('SELECT 1; INSERT INTO t VALUES (1)', 'missing-lock-timeout')).toBe(false);
    expect(has('SET lock_timeout = 0; DROP TABLE a', 'missing-lock-timeout')).toBe(true);
  });
});

describe('concurrently-in-transaction', () => {
  it('flags CONCURRENTLY between BEGIN and COMMIT', () => {
    expect(ids('BEGIN; CREATE INDEX CONCURRENTLY i ON t (a); COMMIT;')).toEqual([
      'concurrently-in-transaction',
    ]);
    expect(ids('START TRANSACTION; DROP INDEX CONCURRENTLY i; COMMIT')).toEqual([
      'concurrently-in-transaction',
    ]);
  });
  it('is fine after COMMIT', () => {
    expect(ids('BEGIN; SELECT 1; COMMIT; CREATE INDEX CONCURRENTLY i ON t (a);')).toEqual([]);
  });
  it('flags when the whole script runs in a transaction (Safe Run), and drops the fix', () => {
    expect(ids('CREATE INDEX CONCURRENTLY i ON t (a)', { inTransaction: true })).toEqual([
      'concurrently-in-transaction',
    ]);
    const f = lintMigration('CREATE INDEX i ON t (a)', { inTransaction: true }).findings.find(
      (x) => x.ruleId === 'create-index-non-concurrent',
    );
    expect(f?.fix).toBeUndefined();
  });
});

describe('settings: enable / threshold / mute', () => {
  const sql = 'CREATE INDEX i ON t (a); ALTER TABLE t RENAME COLUMN a TO b;';
  it('can be disabled entirely', () => {
    expect(lintMigration(sql, { enabled: false }).findings).toEqual([]);
  });
  it('honours the severity threshold', () => {
    const r = lintMigration(sql, { minSeverity: 'error' });
    expect(r.findings.map((f) => f.ruleId)).toEqual(['create-index-non-concurrent']);
    expect(r.suppressed).toBeGreaterThan(0);
  });
  it('honours the mute list', () => {
    expect(ids(sql, { muted: ['create-index-non-concurrent'] })).toEqual(['rename-column']);
  });
  it('worstSeverity ranks findings', () => {
    expect(worstSeverity([])).toBeNull();
    expect(worstSeverity(lintMigration(sql).findings)).toBe('error');
  });
});

describe('tokenizer robustness', () => {
  it('ignores keywords in comments, strings and dollar quotes', () => {
    expect(
      ids(`-- DROP TABLE a
        SELECT 'DROP TABLE b', $$ TRUNCATE c $$; /* VACUUM FULL d */`),
    ).toEqual([]);
  });
  it('handles quoted and qualified names', () => {
    const f = lintMigration('CREATE INDEX i ON "Sales"."Order Items" (a)').findings.find(
      (x) => x.ruleId === 'create-index-non-concurrent',
    );
    expect(f?.target).toBe('Sales.Order Items');
  });
  it('reports offsets within the original script', () => {
    const sql = 'SELECT 1;\n  DROP TABLE a;';
    const f = lintMigration(sql).findings.find((x) => x.ruleId === 'drop-table')!;
    expect(sql.slice(f.start, f.end)).toBe('DROP TABLE');
    expect(f.statementIndex).toBe(1);
  });
});

describe('applyLintFix', () => {
  it('applies a fix and the result no longer triggers the rule', () => {
    const sql = 'ALTER TABLE t ADD CONSTRAINT c CHECK (a > 0);\nCREATE INDEX i ON t (a);';
    for (const f of lintMigration(sql).findings.filter((x) => x.fix)) {
      const fixed = applyLintFix(sql, f.fix!);
      expect(lintMigration(fixed).findings.map((x) => x.ruleId)).not.toContain(f.ruleId);
    }
  });
  it('inserts lock_timeout at the top', () => {
    const sql = 'DROP TABLE a;';
    const f = lintMigration(sql).findings.find((x) => x.ruleId === 'missing-lock-timeout')!;
    expect(applyLintFix(sql, f.fix!)).toBe("SET lock_timeout = '5s';\nDROP TABLE a;");
  });
});
