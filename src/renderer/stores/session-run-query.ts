/**
 * Query-run ownership (U39 / advisor simplification #1).
 *
 * Owns: capturing origin-tab + generation context, multi-statement
 * transport via IPC, result/error publication, and transactionMode
 * status mirroring. Prod-gate arming is delegated to session-prod-gate;
 * table-tab compilation stays with the table helpers passed in as deps.
 */
import { ipc } from '@/lib/ipc';
import { splitSqlStatements } from '@/lib/sql-split';
import type { QueryResult } from '@shared/protocol';
import { armProdGateIfNeeded } from './session-prod-gate';
import { looksLikeDdl } from './session-sql-heuristics';
import type { QueryTab } from './session';

/**
 * Zustand set/get are typed loosely here so this module can compose into
 * the full SessionState store without importing it (avoids cycles).
 */
// biome-ignore lint/suspicious/noExplicitAny: slice composed into SessionState
type Set = (partial: any, ...args: any[]) => void;
// biome-ignore lint/suspicious/noExplicitAny: slice composed into SessionState
type Get = () => any;

export type RunQueryDeps = {
  patchTabById: (set: Set, tabId: string, patch: Partial<QueryTab>) => void;
  runTableDataQuery: (set: Set, get: Get, tabId: string) => Promise<void>;
  runTableCountQuery: (set: Set, get: Get, tabId: string) => Promise<void>;
};

export async function runQuery(set: Set, get: Get, deps: RunQueryDeps): Promise<void> {
  const state = get();
  const tab = state.tabs.find((t: QueryTab) => t.id === state.activeTabId) as QueryTab | undefined;
  if (!tab) return;
  if (tab.queryRunState === 'running') return;

  // Table tabs compile their SQL from structured state.
  if (tab.kind === 'table') {
    await deps.runTableDataQuery(set, get, tab.id);
    void deps.runTableCountQuery(set, get, tab.id);
    return;
  }

  const sql = tab.sql.trim();
  if (!sql) return;

  // Prod gate ownership lives in session-prod-gate.
  if (armProdGateIfNeeded(set, get, sql)) return;

  // U03 + U01: capture origin tab + query generation + connection
  // generation before any await so results/errors publish only to that
  // tab on the same connection (not whichever is active later).
  const originTabId = tab.id;
  const generation = tab.queryGeneration + 1;
  const originConnGen = state.connectionGen as number;
  deps.patchTabById(set, originTabId, {
    queryRunState: 'running',
    queryError: null,
    queryErrorSql: null,
    queryGeneration: generation,
  });

  const publishOrigin = (patch: Partial<QueryTab>) => {
    const current = get().tabs.find((t: QueryTab) => t.id === originTabId) as QueryTab | undefined;
    // Drop if the origin tab was closed or a newer request superseded it.
    if (!current || current.queryGeneration !== generation) return;
    // Drop result payload if the connection changed under us; still clear
    // running so the origin tab does not stay stuck.
    if (get().connectionGen !== originConnGen) {
      if (patch.queryRunState === 'idle' || patch.queryError != null) {
        deps.patchTabById(set, originTabId, {
          queryRunState: 'idle',
          queryError:
            patch.queryError ??
            'connection changed while query was running — result discarded',
        });
      }
      return;
    }
    deps.patchTabById(set, originTabId, patch);
  };

  // Multi-statement scripts: split with a quote/comment-aware tokenizer
  // and run each separately. Last statement's QueryResult populates the
  // grid; failures stop execution and surface "stopped at N of M".
  const statements = splitSqlStatements(sql);
  try {
    let lastResult: QueryResult | null = null;
    let anyDdl = false;
    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i];
      try {
        lastResult = await ipc.query.run(stmt);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const tag = statements.length > 1 ? ` (statement ${i + 1} of ${statements.length})` : '';
        publishOrigin({
          queryError: `${message}${tag}`,
          queryErrorSql: stmt,
          queryRunState: 'idle',
        });
        if (anyDdl) void get().refreshSchema();
        return;
      }
      if (looksLikeDdl(stmt)) anyDdl = true;
    }
    publishOrigin({
      queryResult: lastResult,
      queryRunState: 'idle',
      page: 0,
      sortColumn: null,
      selectedCell: null,
      selectedRows: new Set(),
    });
    // U05: worker may have auto-BEGUN under transactionMode — mirror
    // that into the status-bar txn indicator.
    if (get().settings.transactionMode && get().connectionGen === originConnGen) {
      const last = statements[statements.length - 1]?.trim().toUpperCase() ?? '';
      if (last.startsWith('COMMIT') || last.startsWith('ROLLBACK') || last.startsWith('ABORT')) {
        set({ txnState: 'none' });
      } else {
        set({ txnState: 'active' });
      }
    }
    if (anyDdl) {
      void get().refreshSchema();
    }
  } catch (err) {
    publishOrigin({
      queryError: err instanceof Error ? err.message : String(err),
      queryErrorSql: sql,
      queryRunState: 'idle',
    });
    if (get().settings.transactionMode && get().connectionGen === originConnGen) {
      set({ txnState: 'error' });
    }
  }
}
