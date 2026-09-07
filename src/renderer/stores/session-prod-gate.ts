/**
 * Prod-gate ownership (U39 / advisor simplification #1).
 *
 * Owns: detecting destructive SQL on prod-tagged connections, arming the
 * confirm dialog (`prodGate`), and resume/abort via confirm/cancel.
 * `runQuery` asks this module whether to proceed; it does not own the gate.
 */
import { splitSqlStatements } from '@/lib/sql-split';
import { looksDestructive } from './session-sql-heuristics';

/**
 * Zustand set/get are typed loosely here so this module can compose into
 * the full SessionState store without importing it (avoids cycles).
 */
// biome-ignore lint/suspicious/noExplicitAny: slice composed into SessionState
type Set = (partial: any, ...args: any[]) => void;
// biome-ignore lint/suspicious/noExplicitAny: slice composed into SessionState
type Get = () => any;

/**
 * If the active connection is prod-tagged and `sql` looks destructive,
 * stash the payload on `prodGate` and return true (caller should abort).
 * Otherwise return false and leave `prodGate` alone.
 */
export function armProdGateIfNeeded(set: Set, get: Get, sql: string): boolean {
  const state = get();
  const connId = state.activeConfig?.id as string | undefined;
  const tag = connId ? state.settings.connectionTags?.[connId] : undefined;
  if (tag === 'prod' && state.prodGate === null) {
    const stmts = splitSqlStatements(sql);
    if (stmts.some(looksDestructive)) {
      set({ prodGate: { sql } });
      return true;
    }
  }
  return false;
}

/** Resume a prod-gated runQuery after the user confirms. */
export function confirmProdGate(set: Set, get: Get): void {
  const gate = get().prodGate;
  if (!gate) return;
  set({ prodGate: null });
  // Re-enter runQuery now that the gate is cleared. The SQL on the
  // active tab still matches what we stashed — runQuery will see no
  // gate set and proceed.
  void get().runQuery();
}

export function cancelProdGate(set: Set): void {
  set({ prodGate: null });
}
