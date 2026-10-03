import {
  type QualifiedName,
  type Token,
  isPunct,
  isWord,
  matchParen,
  parseColumnList,
  parseQualifiedName,
  splitTopLevelCommas,
  tokenizeSql,
} from './pg-sql-tokens';
/**
 * Migration safety linter for Postgres DDL (squawk-inspired). Pure: it takes
 * SQL text plus optional live context (row estimates, column types, indexes)
 * and returns findings; nothing here touches a database.
 *
 * Parsing is deliberately conservative — the shared splitter isolates
 * statements, `tokenizeSql` finds keywords / names, and every rule only
 * fires on shapes it recognises. An unrecognised statement yields no finding
 * rather than a guess.
 */
import { splitSqlStatementRanges } from './sql-split';

export type LintSeverity = 'error' | 'warn' | 'info';

export interface LintRuleMeta {
  id: string;
  severity: LintSeverity;
  title: string;
  message: string;
  alternative: string;
  docs: string;
}

const SQUAWK = 'https://squawkhq.com/docs/';
const PG_ALTER = 'https://www.postgresql.org/docs/current/sql-altertable.html';
const PG_LOCKS = 'https://www.postgresql.org/docs/current/explicit-locking.html';

function rule(r: LintRuleMeta): LintRuleMeta {
  return r;
}

export const LINT_RULES = {
  'create-index-non-concurrent': rule({
    id: 'create-index-non-concurrent',
    severity: 'error',
    title: 'CREATE INDEX without CONCURRENTLY',
    message:
      'CREATE INDEX takes a SHARE lock that blocks every write to the table for the whole build.',
    alternative: 'Use CREATE INDEX CONCURRENTLY (outside a transaction block).',
    docs: `${SQUAWK}require-concurrent-index-creation`,
  }),
  'create-unique-index-non-concurrent': rule({
    id: 'create-unique-index-non-concurrent',
    severity: 'error',
    title: 'Unique index / constraint built while blocking writes',
    message:
      'Building a unique index (or ADD UNIQUE / ADD PRIMARY KEY) without CONCURRENTLY blocks writes while the index is built.',
    alternative:
      'CREATE UNIQUE INDEX CONCURRENTLY first, then ALTER TABLE … ADD CONSTRAINT … UNIQUE USING INDEX.',
    docs: `${SQUAWK}disallowed-unique-constraint`,
  }),
  'drop-index-non-concurrent': rule({
    id: 'drop-index-non-concurrent',
    severity: 'warn',
    title: 'DROP INDEX without CONCURRENTLY',
    message:
      'DROP INDEX takes an ACCESS EXCLUSIVE lock on the table, blocking reads and writes until it gets the lock and finishes.',
    alternative: 'Use DROP INDEX CONCURRENTLY (outside a transaction block).',
    docs: `${SQUAWK}require-concurrent-index-deletion`,
  }),
  'add-column-volatile-default': rule({
    id: 'add-column-volatile-default',
    severity: 'error',
    title: 'ADD COLUMN forces a table rewrite',
    message:
      'A volatile DEFAULT (or a stored generated / identity / serial column, or any DEFAULT on PostgreSQL < 11) rewrites the whole table under an ACCESS EXCLUSIVE lock.',
    alternative:
      'Add the column without a default (or with a constant default on PG 11+), then backfill in batches and SET DEFAULT.',
    docs: `${SQUAWK}adding-field-with-default`,
  }),
  'add-column-not-null-no-default': rule({
    id: 'add-column-not-null-no-default',
    severity: 'error',
    title: 'ADD COLUMN … NOT NULL without a default',
    message: 'Adding a NOT NULL column without a DEFAULT fails on any table that already has rows.',
    alternative:
      'Add the column as nullable (or with a constant DEFAULT), backfill, then add a CHECK (col IS NOT NULL) NOT VALID, VALIDATE it and SET NOT NULL.',
    docs: `${SQUAWK}adding-not-nullable-field`,
  }),
  'set-not-null': rule({
    id: 'set-not-null',
    severity: 'warn',
    title: 'SET NOT NULL scans the whole table',
    message:
      'SET NOT NULL scans every row while holding an ACCESS EXCLUSIVE lock, blocking reads and writes on a big table.',
    alternative:
      'ADD CONSTRAINT … CHECK (col IS NOT NULL) NOT VALID, then VALIDATE CONSTRAINT, then SET NOT NULL (PG 12+ skips the scan) and drop the CHECK.',
    docs: `${SQUAWK}setting-not-nullable-field`,
  }),
  'change-column-type': rule({
    id: 'change-column-type',
    severity: 'error',
    title: 'ALTER COLUMN TYPE rewrites the table',
    message:
      'Changing a column type rewrites the table (and its indexes) under an ACCESS EXCLUSIVE lock unless the change is binary compatible.',
    alternative:
      'Add a new column, backfill in batches (trigger to keep in sync), then swap and drop the old column.',
    docs: `${SQUAWK}changing-column-type`,
  }),
  'add-foreign-key-not-valid': rule({
    id: 'add-foreign-key-not-valid',
    severity: 'error',
    title: 'ADD FOREIGN KEY without NOT VALID',
    message:
      'Validating a new foreign key scans the table while holding SHARE ROW EXCLUSIVE on both tables, blocking writes.',
    alternative:
      'ADD CONSTRAINT … FOREIGN KEY … NOT VALID, then VALIDATE CONSTRAINT in a separate step.',
    docs: `${SQUAWK}adding-foreign-key-constraint`,
  }),
  'fk-missing-index': rule({
    id: 'fk-missing-index',
    severity: 'warn',
    title: 'Foreign key columns have no index',
    message:
      'Without an index on the referencing columns, deletes/updates on the parent table scan this table and can block on locks.',
    alternative: 'CREATE INDEX CONCURRENTLY on the foreign-key column(s).',
    docs: 'https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-FK',
  }),
  'add-check-not-valid': rule({
    id: 'add-check-not-valid',
    severity: 'error',
    title: 'ADD CONSTRAINT CHECK without NOT VALID',
    message:
      'Adding a CHECK constraint scans the table under an ACCESS EXCLUSIVE lock, blocking reads and writes.',
    alternative:
      'ADD CONSTRAINT … CHECK (…) NOT VALID, then VALIDATE CONSTRAINT in a separate step.',
    docs: `${SQUAWK}constraint-missing-not-valid`,
  }),
  'rename-column': rule({
    id: 'rename-column',
    severity: 'warn',
    title: 'RENAME COLUMN breaks running applications',
    message: 'Code that still uses the old column name fails the moment this runs.',
    alternative:
      'Add the new column, dual-write / backfill, deploy the code change, then drop the old column.',
    docs: `${SQUAWK}renaming-column`,
  }),
  'rename-table': rule({
    id: 'rename-table',
    severity: 'warn',
    title: 'RENAME TABLE breaks running applications',
    message: 'Code that still uses the old table name fails the moment this runs.',
    alternative: 'Create a view with the old name after renaming, or migrate via a new table.',
    docs: `${SQUAWK}renaming-table`,
  }),
  'drop-column': rule({
    id: 'drop-column',
    severity: 'warn',
    title: 'DROP COLUMN is destructive',
    message: 'Dropping a column loses its data and breaks queries that still reference it.',
    alternative: 'Stop reading/writing the column in the app first; drop it in a later release.',
    docs: `${SQUAWK}ban-drop-column`,
  }),
  'drop-table': rule({
    id: 'drop-table',
    severity: 'warn',
    title: 'DROP TABLE is destructive',
    message: 'Dropping a table loses its data and breaks anything that still references it.',
    alternative: 'Rename it out of the way first (and keep a backup) before dropping for good.',
    docs: `${SQUAWK}ban-drop-table`,
  }),
  'vacuum-full-cluster': rule({
    id: 'vacuum-full-cluster',
    severity: 'error',
    title: 'VACUUM FULL / CLUSTER rewrites the table',
    message:
      'VACUUM FULL and CLUSTER rewrite the table under an ACCESS EXCLUSIVE lock, blocking all access for the duration.',
    alternative: 'Use plain VACUUM, or pg_repack / pg_squeeze for online compaction.',
    docs: 'https://www.postgresql.org/docs/current/sql-vacuum.html',
  }),
  truncate: rule({
    id: 'truncate',
    severity: 'warn',
    title: 'TRUNCATE removes all rows',
    message:
      'TRUNCATE takes an ACCESS EXCLUSIVE lock and instantly discards every row; it cannot be filtered or batched.',
    alternative: 'DELETE in batches if the table must stay available.',
    docs: `${SQUAWK}ban-truncate-cascade`,
  }),
  'change-primary-key': rule({
    id: 'change-primary-key',
    severity: 'error',
    title: 'Changing a primary key',
    message:
      'Adding or dropping a primary key takes an ACCESS EXCLUSIVE lock, rebuilds an index and can break foreign keys and replication identity.',
    alternative:
      'CREATE UNIQUE INDEX CONCURRENTLY first, then ADD CONSTRAINT … PRIMARY KEY USING INDEX (drop the old key in the same transaction).',
    docs: PG_ALTER,
  }),
  'missing-lock-timeout': rule({
    id: 'missing-lock-timeout',
    severity: 'info',
    title: 'No lock_timeout set',
    message:
      'Locking DDL queues behind long-running queries, and every query after it queues behind the DDL. Without lock_timeout it can stall the table indefinitely.',
    alternative: "SET lock_timeout = '5s'; at the top of the script and retry on failure.",
    docs: PG_LOCKS,
  }),
  'concurrently-in-transaction': rule({
    id: 'concurrently-in-transaction',
    severity: 'error',
    title: 'CONCURRENTLY inside a transaction block',
    message:
      'CONCURRENTLY cannot run inside a transaction block; Postgres will reject the statement.',
    alternative:
      'Run the CONCURRENTLY statement on its own, outside BEGIN … COMMIT (and outside Safe Run).',
    docs: `${SQUAWK}ban-concurrent-index-creation-in-transaction`,
  }),
} as const satisfies Record<string, LintRuleMeta>;

export type LintRuleId = keyof typeof LINT_RULES;
export const LINT_RULE_IDS = Object.keys(LINT_RULES) as LintRuleId[];

export interface LintEdit {
  start: number;
  end: number;
  text: string;
}

export interface LintFix {
  title: string;
  edits: LintEdit[];
}

export interface LintFinding {
  ruleId: LintRuleId;
  severity: LintSeverity;
  title: string;
  message: string;
  alternative: string;
  docs: string;
  /** Index of the offending statement in the script. */
  statementIndex: number;
  /** Source offsets of the part to underline. */
  start: number;
  end: number;
  /** Table / index the finding is about, when known. */
  target?: string;
  fix?: LintFix;
}

export interface LintOptions {
  /** Master switch (Settings → Editor). Default true. */
  enabled?: boolean;
  /** Drop findings below this severity. Default 'info'. */
  minSeverity?: LintSeverity;
  /** Rule ids to mute. */
  muted?: readonly string[];
  /** The script will run inside a transaction (Safe Run). */
  inTransaction?: boolean;
  /** Server major version, e.g. 15. Unknown → assume modern (≥ 11). */
  pgVersion?: number | null;
  /** Estimated rows for a table key (see `tableKey`). */
  tableRows?: (key: string) => number | null | undefined;
  /** Current type of a column, e.g. `character varying(20)`. */
  columnType?: (tableKey: string, column: string) => string | null | undefined;
  /** Does the table have an index whose leading columns are `cols`? */
  hasIndex?: (tableKey: string, cols: string[]) => boolean | null | undefined;
}

/** Tables with fewer estimated rows than this are treated as cheap to scan. */
export const SMALL_TABLE_ROWS = 10_000;

const SEVERITY_RANK: Record<LintSeverity, number> = { info: 0, warn: 1, error: 2 };

export function severityAtLeast(s: LintSeverity, min: LintSeverity): boolean {
  return SEVERITY_RANK[s] >= SEVERITY_RANK[min];
}

/** Lookup key for a table: `public.` is implied, other schemas stay qualified. */
export function tableKey(n: { schema: string | null; name: string }): string {
  return n.schema && n.schema !== 'public' ? `${n.schema}.${n.name}` : n.name;
}

// ─── Type-change classification ──────────────────────────────────────

const TYPE_ALIASES: Record<string, string> = {
  'character varying': 'varchar',
  character: 'bpchar',
  char: 'bpchar',
  integer: 'int4',
  int: 'int4',
  smallint: 'int2',
  bigint: 'int8',
  decimal: 'numeric',
  'timestamp without time zone': 'timestamp',
  'timestamp with time zone': 'timestamptz',
  'time without time zone': 'time',
  'time with time zone': 'timetz',
  boolean: 'bool',
  'double precision': 'float8',
  real: 'float4',
};

export interface NormalizedType {
  base: string;
  args: number[];
  array: boolean;
}

export function normalizePgType(raw: string): NormalizedType {
  let s = raw.trim().toLowerCase().replace(/"/g, '').replace(/\s+/g, ' ');
  const array = /\[\s*\d*\s*\]\s*$/.test(s) || /\barray\b/.test(s);
  s = s
    .replace(/\[\s*\d*\s*\]/g, '')
    .replace(/\barray\b/, '')
    .trim();
  const m = /^([^(]*)(?:\(([^)]*)\))?\s*(.*)$/.exec(s);
  let base = (m?.[1] ?? s).trim();
  const tail = (m?.[3] ?? '').trim();
  // `timestamp(3) with time zone`: the qualifier follows the parens.
  if (tail) base = `${base} ${tail}`;
  base = base.replace(/^pg_catalog\./, '');
  base = TYPE_ALIASES[base] ?? base;
  const args = (m?.[2] ?? '')
    .split(',')
    .map((x) => Number.parseInt(x.trim(), 10))
    .filter((n) => Number.isFinite(n));
  return { base, args, array };
}

/**
 * True when `ALTER COLUMN … TYPE to` on a column of type `from` needs no
 * table rewrite: varchar(n) → varchar(m ≥ n) / varchar / text, text → varchar,
 * numeric(p,s) → numeric(p' ≥ p, s) / numeric. Everything else — int → bigint,
 * timestamp → timestamptz, shrinking a varchar — is treated as a rewrite.
 */
export function isRewriteFreeTypeChange(from: string, to: string): boolean {
  const a = normalizePgType(from);
  const b = normalizePgType(to);
  if (a.array !== b.array) return false;
  const sameArgs = a.args.length === b.args.length && a.args.every((x, i) => x === b.args[i]);
  if (a.base === b.base && sameArgs) return true;
  const textual = (t: NormalizedType) => t.base === 'varchar' || t.base === 'text';
  if (a.array || b.array) return false;
  if (textual(a) && textual(b)) {
    const bUnbounded = b.base === 'text' || b.args.length === 0;
    if (bUnbounded) return true;
    // varchar(n) → varchar(m): free when growing; text → varchar(n) must verify lengths.
    if (a.base === 'varchar' && b.base === 'varchar' && a.args.length === 1) {
      return b.args[0]! >= a.args[0]!;
    }
    return false;
  }
  if (a.base === 'numeric' && b.base === 'numeric') {
    if (b.args.length === 0) return true;
    if (a.args.length === 0) return false;
    const [p1, s1 = 0] = a.args;
    const [p2, s2 = 0] = b.args;
    return p2! >= p1! && s1 === s2;
  }
  return false;
}

// ─── Statement analysis ──────────────────────────────────────────────

const VOLATILE_FUNCS = new Set([
  'random',
  'random_normal',
  'setseed',
  'clock_timestamp',
  'timeofday',
  'gen_random_uuid',
  'gen_random_bytes',
  'gen_salt',
  'uuid_generate_v1',
  'uuid_generate_v1mc',
  'uuid_generate_v4',
  'uuidv4',
  'uuidv7',
  'nextval',
  'setval',
  'txid_current',
  'pg_current_xact_id',
  'pg_backend_pid',
]);

const COLUMN_BOUNDARY = new Set([
  'not',
  'null',
  'default',
  'constraint',
  'check',
  'primary',
  'unique',
  'references',
  'generated',
  'collate',
  'deferrable',
  'initially',
]);

/** True when a DEFAULT expression calls a known volatile function. */
export function hasVolatileDefault(expr: Token[]): boolean {
  for (let i = 0; i < expr.length; i++) {
    const t = expr[i]!;
    if (t.kind === 'word' && VOLATILE_FUNCS.has(t.value)) {
      // `pg_catalog.random()` and plain `random()`: require a call.
      if (isPunct(expr[i + 1], '(')) return true;
    }
  }
  return false;
}

interface Ctx {
  sql: string;
  opts: LintOptions;
  findings: LintFinding[];
  created: Set<string>;
  scriptIndexes: { table: string; cols: string[] }[];
  inTxn: boolean;
  lockTimeoutSet: boolean;
  lockingDdlSeen: boolean;
}

function span(a: Token, b: Token): { start: number; end: number } {
  return { start: a.start, end: b.end };
}

function emit(
  ctx: Ctx,
  ruleId: LintRuleId,
  statementIndex: number,
  range: { start: number; end: number },
  extra: { target?: string; severity?: LintSeverity; fix?: LintFix; detail?: string } = {},
): void {
  const meta: LintRuleMeta = LINT_RULES[ruleId];
  ctx.findings.push({
    ruleId,
    severity: extra.severity ?? meta.severity,
    title: meta.title,
    message: extra.detail ? `${meta.message} ${extra.detail}` : meta.message,
    alternative: meta.alternative,
    docs: meta.docs,
    statementIndex,
    start: range.start,
    end: range.end,
    ...(extra.target ? { target: extra.target } : {}),
    ...(extra.fix ? { fix: extra.fix } : {}),
  });
}

function isSmall(ctx: Ctx, key: string): boolean {
  const rows = ctx.opts.tableRows?.(key);
  return typeof rows === 'number' && rows >= 0 && rows < SMALL_TABLE_ROWS;
}

function findWord(toks: Token[], from: number, ...words: string[]): number {
  for (let i = from; i < toks.length; i++) {
    if (isWord(toks[i], ...words)) return i;
  }
  return -1;
}

function hasSeq(toks: Token[], ...words: string[]): boolean {
  for (let i = 0; i + words.length <= toks.length; i++) {
    if (words.every((w, k) => isWord(toks[i + k], w))) return true;
  }
  return false;
}

/** Index of the next `)`-balanced boundary keyword at depth 0, else end. */
function endOfDefault(toks: Token[], from: number): number {
  let depth = 0;
  for (let i = from; i < toks.length; i++) {
    const t = toks[i]!;
    if (isPunct(t, '(')) depth++;
    else if (isPunct(t, ')')) depth--;
    else if (depth === 0 && t.kind === 'word' && COLUMN_BOUNDARY.has(t.value)) return i;
  }
  return toks.length;
}

function lintStatement(ctx: Ctx, idx: number, text: string, offset: number): void {
  const toks = tokenizeSql(text, offset);
  if (toks.length === 0) return;
  const first = toks[0]!;
  const kw = first.kind === 'word' ? first.value : '';

  switch (kw) {
    case 'begin':
    case 'start':
      if (kw === 'start' && !isWord(toks[1], 'transaction')) return;
      ctx.inTxn = true;
      return;
    case 'commit':
    case 'end':
    case 'rollback':
    case 'abort':
      ctx.inTxn = false;
      return;
    case 'set':
      noteLockTimeout(ctx, toks);
      return;
    case 'create':
      lintCreate(ctx, idx, toks);
      return;
    case 'drop':
      lintDrop(ctx, idx, toks);
      return;
    case 'alter':
      if (isWord(toks[1], 'table')) lintAlterTable(ctx, idx, toks);
      return;
    case 'truncate': {
      ctx.lockingDdlSeen = true;
      noteLockingDdl(ctx, idx, first);
      emit(ctx, 'truncate', idx, span(first, toks[Math.min(1, toks.length - 1)]!), {
        ...(hasSeq(toks, 'cascade')
          ? { detail: 'CASCADE also empties every table that references it.' }
          : {}),
      });
      return;
    }
    case 'vacuum': {
      const full =
        isWord(toks[1], 'full') ||
        (isPunct(toks[1], '(') &&
          toks.slice(2, matchParen(toks, 1)).some((t) => isWord(t, 'full')));
      if (full) {
        noteLockingDdl(ctx, idx, first);
        emit(ctx, 'vacuum-full-cluster', idx, span(first, toks[1]!));
      }
      return;
    }
    case 'cluster':
      noteLockingDdl(ctx, idx, first);
      emit(ctx, 'vacuum-full-cluster', idx, span(first, first));
      return;
    case 'reindex':
      if (hasSeq(toks, 'concurrently')) {
        const c = toks[findWord(toks, 0, 'concurrently')]!;
        checkConcurrentlyTxn(ctx, idx, c);
      } else noteLockingDdl(ctx, idx, first);
      return;
    default:
  }
}

function noteLockTimeout(ctx: Ctx, toks: Token[]): void {
  // SET [SESSION|LOCAL] lock_timeout { = | TO } value
  let i = 1;
  if (isWord(toks[i], 'session', 'local')) i++;
  if (!isWord(toks[i], 'lock_timeout')) return;
  const v = toks[i + 2];
  const zero = !v || v.value === 'default' || /^'?0*(ms|s)?'?$/.test(v.text.toLowerCase());
  ctx.lockTimeoutSet = !zero;
}

/** First locking DDL in a script without `lock_timeout` gets the nudge. */
function noteLockingDdl(ctx: Ctx, idx: number, at: Token): void {
  ctx.lockingDdlSeen = true;
  if (ctx.lockTimeoutSet) return;
  if (ctx.findings.some((f) => f.ruleId === 'missing-lock-timeout')) return;
  emit(
    ctx,
    'missing-lock-timeout',
    idx,
    { start: at.start, end: at.end },
    {
      fix: {
        title: "Add SET lock_timeout = '5s'",
        edits: [{ start: 0, end: 0, text: "SET lock_timeout = '5s';\n" }],
      },
    },
  );
}

function checkConcurrentlyTxn(ctx: Ctx, idx: number, concurrentlyTok: Token): void {
  if (ctx.inTxn || ctx.opts.inTransaction) {
    emit(ctx, 'concurrently-in-transaction', idx, span(concurrentlyTok, concurrentlyTok));
  }
}

function lintCreate(ctx: Ctx, idx: number, toks: Token[]): void {
  let i = 1;
  if (isWord(toks[i], 'or') && isWord(toks[i + 1], 'replace')) i += 2;
  let unique = false;
  if (isWord(toks[i], 'unique')) {
    unique = true;
    i++;
  }
  if (isWord(toks[i], 'global', 'local')) i++;
  if (isWord(toks[i], 'temp', 'temporary', 'unlogged')) i++;
  const what = toks[i];
  if (isWord(what, 'table')) {
    i++;
    if (isWord(toks[i], 'if') && isWord(toks[i + 1], 'not') && isWord(toks[i + 2], 'exists'))
      i += 3;
    const n = parseQualifiedName(toks, i);
    if (n) ctx.created.add(tableKey(n.name));
    return;
  }
  if (!isWord(what, 'index')) return;
  const indexTok = what!;
  i++;
  const concurrentlyAt = isWord(toks[i], 'concurrently') ? i : -1;
  if (concurrentlyAt >= 0) i++;
  if (isWord(toks[i], 'if') && isWord(toks[i + 1], 'not') && isWord(toks[i + 2], 'exists')) i += 3;
  if (!isWord(toks[i], 'on')) {
    const nm = parseQualifiedName(toks, i);
    if (nm) i = nm.next;
  }
  if (!isWord(toks[i], 'on')) return;
  i++;
  if (isWord(toks[i], 'only')) i++;
  const tbl = parseQualifiedName(toks, i);
  if (!tbl) return;
  const key = tableKey(tbl.name);
  i = tbl.next;
  if (isWord(toks[i], 'using')) i += 2;
  const open = toks.findIndex((t, k) => k >= i && isPunct(t, '('));
  const cols = isPunct(toks[open], '(') ? parseColumnList(toks, open).cols : [];
  ctx.scriptIndexes.push({ table: key, cols });

  if (concurrentlyAt >= 0) {
    checkConcurrentlyTxn(ctx, idx, toks[concurrentlyAt]!);
    return;
  }
  if (ctx.created.has(key)) return; // brand-new table: nobody is using it yet
  noteLockingDdl(ctx, idx, toks[0]!);
  if (isSmall(ctx, key)) return;
  const range = span(toks[0]!, indexTok);
  const fix: LintFix | undefined =
    ctx.inTxn || ctx.opts.inTransaction
      ? undefined
      : {
          title: 'Add CONCURRENTLY',
          edits: [{ start: indexTok.end, end: indexTok.end, text: ' CONCURRENTLY' }],
        };
  emit(
    ctx,
    unique ? 'create-unique-index-non-concurrent' : 'create-index-non-concurrent',
    idx,
    range,
    {
      target: tbl.name.display,
      ...(fix ? { fix } : {}),
    },
  );
}

function lintDrop(ctx: Ctx, idx: number, toks: Token[]): void {
  const what = toks[1];
  if (isWord(what, 'index')) {
    const i = 2;
    const concurrentlyAt = isWord(toks[i], 'concurrently') ? i : -1;
    if (concurrentlyAt >= 0) {
      checkConcurrentlyTxn(ctx, idx, toks[concurrentlyAt]!);
      return;
    }
    noteLockingDdl(ctx, idx, toks[0]!);
    const names = splitTopLevelCommas(toks.slice(i)).length;
    const cascade = hasSeq(toks, 'cascade');
    const fix: LintFix | undefined =
      names === 1 && !cascade && !(ctx.inTxn || ctx.opts.inTransaction)
        ? {
            title: 'Add CONCURRENTLY',
            edits: [{ start: what!.end, end: what!.end, text: ' CONCURRENTLY' }],
          }
        : undefined;
    emit(ctx, 'drop-index-non-concurrent', idx, span(toks[0]!, what!), fix ? { fix } : {});
    return;
  }
  if (isWord(what, 'table')) {
    let i = 2;
    if (isWord(toks[i], 'if') && isWord(toks[i + 1], 'exists')) i += 2;
    const names: QualifiedName[] = [];
    for (const group of splitTopLevelCommas(toks.slice(i))) {
      const n = parseQualifiedName(group, 0);
      if (n) names.push(n.name);
    }
    if (names.length > 0 && names.every((n) => ctx.created.has(tableKey(n)))) return;
    noteLockingDdl(ctx, idx, toks[0]!);
    emit(ctx, 'drop-table', idx, span(toks[0]!, what!), {
      ...(names[0] ? { target: names.map((n) => n.display).join(', ') } : {}),
    });
  }
}

interface AlterHead {
  table: QualifiedName;
  actions: Token[][];
}

function parseAlterTable(toks: Token[]): AlterHead | null {
  let i = 2;
  if (isWord(toks[i], 'if') && isWord(toks[i + 1], 'exists')) i += 2;
  if (isWord(toks[i], 'only')) i++;
  const n = parseQualifiedName(toks, i);
  if (!n) return null;
  i = n.next;
  if (isPunct(toks[i], '*')) i++;
  return { table: n.name, actions: splitTopLevelCommas(toks.slice(i)) };
}

function lintAlterTable(ctx: Ctx, idx: number, toks: Token[]): void {
  const head = parseAlterTable(toks);
  if (!head) return;
  const key = tableKey(head.table);
  const fresh = ctx.created.has(key);
  if (!fresh) noteLockingDdl(ctx, idx, toks[0]!);
  for (const a of head.actions) {
    if (a.length === 0) continue;
    const verb = a[0]!;
    if (isWord(verb, 'add')) lintAdd(ctx, idx, head.table, key, a, fresh);
    else if (isWord(verb, 'alter')) lintAlterColumn(ctx, idx, head.table, key, a, fresh);
    else if (isWord(verb, 'drop')) lintDropAction(ctx, idx, head.table, key, a, fresh);
    else if (isWord(verb, 'rename')) lintRename(ctx, idx, head.table, a, fresh);
    else if (isWord(verb, 'detach') && hasSeq(a, 'concurrently')) {
      checkConcurrentlyTxn(ctx, idx, a[findWord(a, 0, 'concurrently')]!);
    }
  }
}

function lintRename(ctx: Ctx, idx: number, table: QualifiedName, a: Token[], fresh: boolean): void {
  if (fresh) return;
  const next = a[1];
  if (isWord(next, 'to')) {
    emit(ctx, 'rename-table', idx, span(a[0]!, a[a.length - 1]!), { target: table.display });
  } else if (isWord(next, 'constraint')) {
    // harmless for applications
  } else {
    emit(ctx, 'rename-column', idx, span(a[0]!, a[a.length - 1]!), { target: table.display });
  }
}

function lintDropAction(
  ctx: Ctx,
  idx: number,
  table: QualifiedName,
  _key: string,
  a: Token[],
  fresh: boolean,
): void {
  if (fresh) return;
  let i = 1;
  if (isWord(a[i], 'constraint')) {
    i++;
    if (isWord(a[i], 'if') && isWord(a[i + 1], 'exists')) i += 2;
    const nm = a[i];
    if (nm && /(_pkey|^pk_|_pk$)/i.test(nm.value)) {
      emit(ctx, 'change-primary-key', idx, span(a[0]!, a[a.length - 1]!), {
        target: table.display,
      });
    }
    return;
  }
  if (isWord(a[i], 'not') || isWord(a[i], 'default') || isWord(a[i], 'identity')) return;
  emit(ctx, 'drop-column', idx, span(a[0]!, a[a.length - 1]!), { target: table.display });
}

function lintAlterColumn(
  ctx: Ctx,
  idx: number,
  table: QualifiedName,
  key: string,
  a: Token[],
  fresh: boolean,
): void {
  if (fresh) return;
  let i = 1;
  if (isWord(a[i], 'column')) i++;
  const col = a[i];
  if (!col || (col.kind !== 'word' && col.kind !== 'quoted')) return;
  const colName = col.kind === 'quoted' ? col.value : col.value.toLowerCase();
  i++;
  const range = span(a[0]!, a[a.length - 1]!);
  if (isWord(a[i], 'set') && isWord(a[i + 1], 'not') && isWord(a[i + 2], 'null')) {
    if (isSmall(ctx, key)) return;
    emit(ctx, 'set-not-null', idx, range, { target: table.display });
    return;
  }
  let typeAt = -1;
  if (isWord(a[i], 'type')) typeAt = i + 1;
  else if (isWord(a[i], 'set') && isWord(a[i + 1], 'data') && isWord(a[i + 2], 'type'))
    typeAt = i + 3;
  if (typeAt < 0) return;
  if (isSmall(ctx, key)) return;
  let endAt = a.length;
  for (let k = typeAt; k < a.length; k++) {
    if (isWord(a[k], 'using', 'collate')) {
      endAt = k;
      break;
    }
  }
  const newType = a
    .slice(typeAt, endAt)
    .map((t) => t.text)
    .join(' ')
    .replace(/\s*\(\s*/g, '(')
    .replace(/\s*\)\s*/g, ')')
    .replace(/\s*,\s*/g, ',');
  const hasUsing = findWord(a, typeAt, 'using') >= 0;
  const old = ctx.opts.columnType?.(key, colName) ?? null;
  if (old) {
    if (!hasUsing && isRewriteFreeTypeChange(old, newType)) return;
    emit(ctx, 'change-column-type', idx, range, {
      target: `${table.display}.${colName}`,
      detail: `${old} → ${newType}${hasUsing ? ' (with USING)' : ''}.`,
    });
    return;
  }
  const nt = normalizePgType(newType);
  const widening = nt.base === 'text' || (nt.base === 'varchar' && nt.args.length === 0);
  if (widening && !hasUsing && !nt.array) {
    emit(ctx, 'change-column-type', idx, range, {
      target: `${table.display}.${colName}`,
      severity: 'info',
      detail:
        'Free of a rewrite only if the column is currently varchar(n)/text; any other source type rewrites.',
    });
    return;
  }
  emit(ctx, 'change-column-type', idx, range, {
    target: `${table.display}.${colName}`,
    detail: `New type: ${newType}${hasUsing ? ' (with USING)' : ''}.`,
  });
}

function lintAdd(
  ctx: Ctx,
  idx: number,
  table: QualifiedName,
  key: string,
  a: Token[],
  fresh: boolean,
): void {
  let i = 1;
  const constraintStart = ['constraint', 'foreign', 'check', 'unique', 'primary', 'exclude'];
  if (!isWord(a[i], 'column') && isWord(a[i], ...constraintStart)) {
    lintAddConstraint(ctx, idx, table, key, a, fresh);
    return;
  }
  if (fresh) return;
  if (isWord(a[i], 'column')) i++;
  if (isWord(a[i], 'if') && isWord(a[i + 1], 'not') && isWord(a[i + 2], 'exists')) i += 3;
  const colTok = a[i];
  if (!colTok) return;
  i++;
  // type tokens run to the first column-constraint keyword
  let j = i;
  let depth = 0;
  for (; j < a.length; j++) {
    const t = a[j]!;
    if (isPunct(t, '(')) depth++;
    else if (isPunct(t, ')')) depth--;
    else if (depth === 0 && t.kind === 'word' && COLUMN_BOUNDARY.has(t.value)) break;
  }
  const typeToks = a.slice(i, j);
  const rest = a.slice(j);
  const range = span(a[0]!, a[a.length - 1]!);
  const serial = typeToks.length === 1 && /^(small|big)?serial[248]?$/.test(typeToks[0]!.value);

  let defaultExpr: Token[] | null = null;
  let notNull = false;
  let generatedStored = false;
  let identity = false;
  depth = 0;
  for (let k = 0; k < rest.length; k++) {
    const t = rest[k]!;
    if (isPunct(t, '(')) depth++;
    else if (isPunct(t, ')')) depth--;
    if (depth !== 0) continue;
    if (isWord(t, 'default')) {
      const end = endOfDefault(rest, k + 1);
      defaultExpr = rest.slice(k + 1, end);
    } else if (isWord(t, 'not') && isWord(rest[k + 1], 'null')) notNull = true;
    else if (isWord(t, 'generated')) {
      if (hasSeq(rest.slice(k), 'identity')) identity = true;
      else if (hasSeq(rest.slice(k), 'stored')) generatedStored = true;
    }
  }

  const target = table.display;
  const pg = ctx.opts.pgVersion;
  const rewrites =
    serial ||
    identity ||
    generatedStored ||
    (defaultExpr !== null && hasVolatileDefault(defaultExpr)) ||
    (defaultExpr !== null && defaultExpr.length > 0 && typeof pg === 'number' && pg < 11);
  if (rewrites && !isSmall(ctx, key)) {
    const why = serial
      ? 'serial columns default to nextval().'
      : identity
        ? 'identity columns are backed by a sequence.'
        : generatedStored
          ? 'a stored generated column is computed for every row.'
          : typeof pg === 'number' && pg < 11 && !(defaultExpr && hasVolatileDefault(defaultExpr))
            ? `PostgreSQL ${pg} rewrites the table for any DEFAULT.`
            : 'the default is volatile, so it is evaluated per row.';
    emit(ctx, 'add-column-volatile-default', idx, range, { target, detail: `Here ${why}` });
  }
  if (notNull && defaultExpr === null && !serial && !identity && !generatedStored) {
    emit(ctx, 'add-column-not-null-no-default', idx, range, { target });
  }
}

function lintAddConstraint(
  ctx: Ctx,
  idx: number,
  table: QualifiedName,
  key: string,
  a: Token[],
  fresh: boolean,
): void {
  if (fresh) return;
  let i = 1;
  if (isWord(a[i], 'constraint')) i += 2;
  const typeTok = a[i];
  const range = span(a[0]!, a[a.length - 1]!);
  const target = table.display;
  const notValid = hasSeq(a, 'not', 'valid');
  const usingIndex = hasSeq(a, 'using', 'index');
  const last = a[a.length - 1]!;
  const notValidFix: LintFix = {
    title: 'Add NOT VALID',
    edits: [{ start: last.end, end: last.end, text: ' NOT VALID' }],
  };

  if (isWord(typeTok, 'check')) {
    if (notValid || isSmall(ctx, key)) return;
    emit(ctx, 'add-check-not-valid', idx, range, { target, fix: notValidFix });
  } else if (isWord(typeTok, 'foreign')) {
    const open = a.findIndex((t, k) => k >= i && isPunct(t, '('));
    const cols = isPunct(a[open], '(') ? parseColumnList(a, open).cols : [];
    if (!notValid && !isSmall(ctx, key)) {
      emit(ctx, 'add-foreign-key-not-valid', idx, range, { target, fix: notValidFix });
    }
    if (cols.length > 0 && !cols.includes('(expr)')) {
      const inScript = ctx.scriptIndexes.some(
        (ix) =>
          ix.table === key &&
          ix.cols.length >= cols.length &&
          cols.every((c) => ix.cols.slice(0, cols.length).includes(c)),
      );
      if (inScript) return;
      const live = ctx.opts.hasIndex?.(key, cols);
      if (live === true) return;
      emit(ctx, 'fk-missing-index', idx, range, {
        target: `${target}(${cols.join(', ')})`,
        severity: live === false ? 'warn' : 'info',
        ...(live === false ? {} : { detail: 'No matching index was found in this script.' }),
      });
    }
  } else if (isWord(typeTok, 'unique') && !usingIndex) {
    if (isSmall(ctx, key)) return;
    emit(ctx, 'create-unique-index-non-concurrent', idx, range, { target });
  } else if (isWord(typeTok, 'primary') && !usingIndex) {
    emit(ctx, 'change-primary-key', idx, range, { target });
  } else if (isWord(typeTok, 'primary') && usingIndex) {
    emit(ctx, 'change-primary-key', idx, range, {
      target,
      severity: 'warn',
      detail: 'USING INDEX avoids the rebuild, but replacing a key still needs care.',
    });
  }
}

export interface LintResult {
  findings: LintFinding[];
  /** Findings hidden by settings (muted rule / below threshold). */
  suppressed: number;
}

export function lintMigration(sql: string, opts: LintOptions = {}): LintResult {
  if (opts.enabled === false) return { findings: [], suppressed: 0 };
  const ctx: Ctx = {
    sql,
    opts,
    findings: [],
    created: new Set(),
    scriptIndexes: [],
    inTxn: false,
    lockTimeoutSet: false,
    lockingDdlSeen: false,
  };
  const stmts = splitSqlStatementRanges(sql);
  stmts.forEach((s, idx) => {
    try {
      lintStatement(ctx, idx, s.text, s.start);
    } catch {
      // A lint bug must never block the user's migration.
    }
  });
  const muted = new Set(opts.muted ?? []);
  const min = opts.minSeverity ?? 'info';
  const findings = ctx.findings.filter(
    (f) => !muted.has(f.ruleId) && severityAtLeast(f.severity, min),
  );
  return { findings, suppressed: ctx.findings.length - findings.length };
}

/** Highest severity present, or null. */
export function worstSeverity(findings: readonly LintFinding[]): LintSeverity | null {
  let worst: LintSeverity | null = null;
  for (const f of findings) {
    if (worst === null || SEVERITY_RANK[f.severity] > SEVERITY_RANK[worst]) worst = f.severity;
  }
  return worst;
}

/** Apply a quick fix's edits to the script (edits never overlap; applied back to front). */
export function applyLintFix(sql: string, fix: LintFix): string {
  let out = sql;
  for (const e of [...fix.edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}
