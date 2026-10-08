/**
 * Safe Run scripts: split a selection into statements and check that every
 * one of them may go through Safe Run. Pure, and shared by the renderer (to
 * refuse early, with a message) and the worker (which never trusts the
 * renderer and checks again before it opens a transaction).
 *
 * A script takes only INSERT / UPDATE / DELETE / MERGE statements (and WITH
 * statements that end in one of those). Everything else, including BEGIN,
 * COMMIT, ROLLBACK, SAVEPOINT and SET, refuses the whole run before anything
 * executes: a script must not be able to end or reshape the transaction that
 * holds it.
 */
import { parseDml } from './dml-parse';
import { SAFE_RUN_MAX_STATEMENTS } from './protocol';
import { splitSqlStatementRanges } from './sql-split';
import { looksLikeWriteSql } from './sql-statements';

export type SafeRunPlan = { ok: true; statements: string[] } | { ok: false; message: string };

/** First keyword of a statement, upper-cased, for "statement 2 is a SELECT". */
function headWord(sql: string): string {
  const m = /^[\s(]*([A-Za-z_]+)/.exec(
    sql.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, ''),
  );
  return m ? m[1]!.toUpperCase() : '';
}

/** Why one statement cannot go through Safe Run, or null when it can. */
export function safeRunRefusal(sql: string): string | null {
  const p = parseDml(sql);
  if (p.kind === 'insert' || p.kind === 'update' || p.kind === 'delete' || p.kind === 'merge') {
    return null;
  }
  if (p.kind === 'cte') {
    return looksLikeWriteSql(sql) ? null : 'only reads, it changes no data';
  }
  const head = headWord(sql);
  return head ? `is a ${head} statement` : 'is not an INSERT, UPDATE, DELETE or MERGE';
}

export const SAFE_RUN_SINGLE_REFUSAL =
  'Safe Run is for INSERT, UPDATE, DELETE and MERGE statements. Use Run for anything else.';

/**
 * Split `sql` and validate every statement. One statement is checked
 * exactly as before; for several, the message names the first statement
 * that does not qualify.
 */
export function planSafeRunScript(sql: string): SafeRunPlan {
  const statements = splitSqlStatementRanges(sql)
    .map((s) => s.text.trim())
    .filter((s) => s.length > 0);
  if (statements.length === 0) return { ok: false, message: 'There is nothing to run.' };
  if (statements.length > SAFE_RUN_MAX_STATEMENTS) {
    return {
      ok: false,
      message: `A Safe Run takes at most ${SAFE_RUN_MAX_STATEMENTS} statements; this script has ${statements.length}. Nothing was run.`,
    };
  }
  if (statements.length === 1) {
    return safeRunRefusal(statements[0]!) === null
      ? { ok: true, statements }
      : { ok: false, message: SAFE_RUN_SINGLE_REFUSAL };
  }
  for (let i = 0; i < statements.length; i++) {
    const why = safeRunRefusal(statements[i]!);
    if (why !== null) {
      return {
        ok: false,
        message: `Statement ${i + 1} ${why}. A Safe Run script takes only INSERT, UPDATE, DELETE and MERGE statements. Nothing was run.`,
      };
    }
  }
  return { ok: true, statements };
}

/** First line of a statement, trimmed, for lists. */
export function firstLine(sql: string, max = 120): string {
  const line =
    sql
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith('--')) ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
