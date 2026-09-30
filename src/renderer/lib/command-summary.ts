/**
 * Summary for a statement that returned no result set (DDL, DML without
 * RETURNING, SET, …). Postgres reports only the first word of the command
 * tag ("CREATE") and a row count that is meaningless for DDL, so a bare
 * "CREATE · 0 rows affected" reads like the statement did nothing.
 */

/** Command tags whose row count is a real "rows affected / returned" number. */
const ROW_COUNT_COMMANDS = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'COPY',
  'MOVE',
  'FETCH',
  // CREATE TABLE … AS / SELECT INTO report SELECT n.
  'SELECT',
]);

/** Multi-word object kinds, longest first so "MATERIALIZED VIEW" beats "VIEW". */
const OBJECT_KINDS = [
  'OR REPLACE FUNCTION',
  'OR REPLACE PROCEDURE',
  'OR REPLACE VIEW',
  'OR REPLACE TRIGGER',
  'OR REPLACE RULE',
  'UNIQUE INDEX',
  'MATERIALIZED VIEW',
  'FOREIGN TABLE',
  'EVENT TRIGGER',
  'TEMPORARY TABLE',
  'TEMP TABLE',
  'UNLOGGED TABLE',
  'TABLE',
  'VIEW',
  'INDEX',
  'FUNCTION',
  'PROCEDURE',
  'TRIGGER',
  'SEQUENCE',
  'SCHEMA',
  'TYPE',
  'DOMAIN',
  'EXTENSION',
  'ROLE',
  'USER',
  'DATABASE',
  'POLICY',
  'RULE',
  'AGGREGATE',
  'COLLATION',
  'PUBLICATION',
  'SUBSCRIPTION',
];

const DDL_VERBS = new Set(['CREATE', 'ALTER', 'DROP']);

function stripLeadingComments(sql: string): string {
  let s = sql;
  for (;;) {
    const trimmed = s.trimStart();
    if (trimmed.startsWith('--')) {
      const nl = trimmed.indexOf('\n');
      s = nl < 0 ? '' : trimmed.slice(nl + 1);
    } else if (trimmed.startsWith('/*')) {
      const end = trimmed.indexOf('*/');
      s = end < 0 ? '' : trimmed.slice(end + 2);
    } else {
      return trimmed;
    }
  }
}

/** "CREATE VIEW", "DROP TABLE", "ALTER INDEX"… or the command tag as-is. */
export function commandTitle(command: string | undefined, sql?: string): string {
  const tag = (command ?? '').trim().toUpperCase();
  if (sql) {
    const head = stripLeadingComments(sql).replace(/\s+/g, ' ').toUpperCase();
    const verb = head.split(' ', 1)[0] ?? '';
    if (DDL_VERBS.has(verb) && (!tag || tag === verb)) {
      const rest = head.slice(verb.length).trimStart();
      const kind = OBJECT_KINDS.find((k) => rest === k || rest.startsWith(`${k} `));
      if (kind) return `${verb} ${kind.replace(/^OR REPLACE /, '')}`;
      return verb;
    }
  }
  return tag || 'OK';
}

/** Second line under the title: rows for DML, a plain success line otherwise. */
export function commandDetail(command: string | undefined, rowCount: number): string {
  const tag = (command ?? '').trim().toUpperCase();
  if (ROW_COUNT_COMMANDS.has(tag)) {
    const n = rowCount.toLocaleString();
    if (tag === 'SELECT' || tag === 'FETCH') return `${n} ${rowCount === 1 ? 'row' : 'rows'}`;
    return `${n} ${rowCount === 1 ? 'row' : 'rows'} affected`;
  }
  return 'Query executed successfully';
}

/** Compact label for a result tab: "INSERT 3", "SELECT 20", "CREATE TABLE". */
export function commandBadge(command: string | undefined, rowCount: number, sql?: string): string {
  const tag = (command ?? '').trim().toUpperCase();
  if (ROW_COUNT_COMMANDS.has(tag)) return `${tag} ${rowCount.toLocaleString()}`;
  return commandTitle(command, sql);
}
