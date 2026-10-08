import type { SafeRunReport } from '@shared/protocol';

/** What a Safe Run is recorded as in history and the audit log. */
export interface SafeRunRecord {
  runId: string;
  /** The text the user ran (the whole selection). */
  sql: string;
  executedAt: number;
  /** A script (steps in the report) rather than one statement. */
  scripted: boolean;
  /** How many statements the script had when it started. */
  scriptSize: number;
  /** Statements that are currently pending, i.e. would be committed. */
  statements: { index: number; sql: string; affected: number; durationMs: number }[];
}

export function recordOfReport(
  report: SafeRunReport,
  sql: string,
  executedAt: number,
  previous?: SafeRunRecord | null,
): SafeRunRecord {
  const steps = report.steps;
  if (!steps) {
    return {
      runId: report.runId,
      sql,
      executedAt,
      scripted: false,
      scriptSize: 1,
      statements: [{ index: 1, sql, affected: report.affected, durationMs: report.durationMs }],
    };
  }
  return {
    runId: report.runId,
    sql,
    executedAt,
    scripted: true,
    scriptSize: Math.max(previous?.scriptSize ?? 0, steps.length),
    statements: steps
      .filter((st) => st.status === 'done')
      .map((st) => ({
        index: st.index,
        sql: st.statement,
        affected: st.affected,
        durationMs: st.durationMs,
      })),
  };
}

/**
 * The SQL stored in history for a commit. A single statement or a complete
 * script is stored as typed. A partial commit or a script after undo stores
 * only the statements that were committed, under a comment saying so, so
 * running it again from history never repeats statements that were not saved.
 */
export function historySql(rec: SafeRunRecord): string {
  if (!rec.scripted || rec.statements.length === rec.scriptSize) return rec.sql;
  const note = `-- Safe Run committed ${rec.statements.length} of ${rec.scriptSize} statements (${rec.statements
    .map((s) => s.index)
    .join(', ')})`;
  return `${note}\n${rec.statements.map((s) => `${s.sql};`).join('\n')}`;
}
