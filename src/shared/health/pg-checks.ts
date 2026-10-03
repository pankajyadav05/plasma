import { PG_INDEX_CHECKS } from './pg-indexes';
import { PG_MAINTENANCE_CHECKS } from './pg-maintenance';
import { PG_OVERVIEW_CHECKS } from './pg-overview';
import {
  STATEMENTS_SQL,
  type StatementRow,
  interpretStatements,
  loadStatements,
  parseStatements,
} from './pg-statements';
import {
  type CheckResult,
  type PgCheck,
  type Row,
  classifyHealthError,
  unknownResult,
} from './types';

/** Every read-only SQL check except the statements one (it has its own flow). */
export const PG_CHECKS: PgCheck[] = [
  ...PG_OVERVIEW_CHECKS,
  ...PG_INDEX_CHECKS,
  ...PG_MAINTENANCE_CHECKS,
];

export const DEFAULT_CHECK_TIMEOUT_MS = 15_000;

/** Runs one statement on the read-only sideband and returns keyed rows. */
export type PgQueryFn = (
  sql: string,
  params: unknown[] | undefined,
  timeoutMs: number,
) => Promise<Row[]>;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Run a check; a privilege or availability error becomes an "unknown" result, never a throw. */
export async function runPgCheck(check: PgCheck, query: PgQueryFn): Promise<CheckResult> {
  try {
    const rows = await query(check.sql, check.params, check.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS);
    return check.interpret(rows);
  } catch (err) {
    return unknownResult(classifyHealthError(messageOf(err)));
  }
}

export type StatementsState = 'ok' | 'not-installed' | 'unavailable';

export interface StatementsOutcome {
  state: StatementsState;
  rows: StatementRow[];
  result: CheckResult;
}

export async function runStatementsCheck(query: PgQueryFn): Promise<StatementsOutcome> {
  try {
    const rows = await loadStatements((sql) => query(sql, undefined, DEFAULT_CHECK_TIMEOUT_MS));
    return { state: 'ok', rows: parseStatements(rows), result: interpretStatements(rows) };
  } catch (err) {
    const msg = messageOf(err);
    if (
      /pg_stat_statements/.test(msg) &&
      /does not exist|must be loaded|shared_preload_libraries/i.test(msg)
    ) {
      return {
        state: 'not-installed',
        rows: [],
        result: {
          status: 'unknown',
          summary: 'pg_stat_statements not enabled',
          findings: [],
        },
      };
    }
    return { state: 'unavailable', rows: [], result: unknownResult(classifyHealthError(msg)) };
  }
}

export { STATEMENTS_SQL };
