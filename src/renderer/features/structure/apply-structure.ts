import { cleanIpcError } from '@/lib/errors';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import { evaluateGate } from '@/stores/session-prod-gate';
import type { AlterPlan } from '@shared/pg-ddl';
import { formatPlan } from '@shared/pg-ddl';

export type ApplyOutcome =
  | { ok: true; executed: number }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled?: false; message: string; statement?: string };

/**
 * Run DDL from the structure editor / create dialogs. Refuses on a
 * read-only connection, shows the prod-tag / safe-mode confirmation with
 * the exact SQL, runs everything through one worker request (one
 * transaction; CONCURRENTLY statements alone) and refreshes the schema.
 */
export async function applyStructurePlan(plan: AlterPlan, summary: string): Promise<ApplyOutcome> {
  const session = useSession.getState();
  if (session.activeConfig?.readOnly) {
    return {
      ok: false,
      message: 'This connection is read-only — the structure cannot be changed.',
    };
  }
  if (plan.transactional.length === 0 && plan.concurrent.length === 0) {
    return { ok: true, executed: 0 };
  }
  const sql = formatPlan(plan);
  const decision = evaluateGate(useSession.getState, sql, true);
  if (decision.kind === 'refuse') return { ok: false, message: decision.message };
  const confirmed = await session.confirmUserSql(sql, { force: true, summary });
  if (!confirmed) return { ok: false, cancelled: true };
  try {
    const res = await ipc.structure.apply({
      connectionGen: useSession.getState().connectionGen,
      transactional: plan.transactional,
      concurrent: plan.concurrent,
    });
    if (res.executed > 0) await useSession.getState().refreshSchema();
    if (res.error) {
      return {
        ok: false,
        message: cleanIpcError(res.error.message),
        statement: res.error.statement,
      };
    }
    return { ok: true, executed: res.executed };
  } catch (err) {
    return { ok: false, message: cleanIpcError(err instanceof Error ? err.message : String(err)) };
  }
}
