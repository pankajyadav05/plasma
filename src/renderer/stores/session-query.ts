/**
 * Query slice: the editor's run pipeline (multi-statement scripts, prod
 * gate, origin-tab publishing), result switching, NOTICE streaming,
 * formatting and the explicit transaction controls.
 */
import { ipc } from '@/lib/ipc';
import {
  type RunMode,
  resolveRunTarget,
  splitSqlStatements,
  unsupportedStatementReason,
} from '@/lib/sql-split';
import type { PgNotice, QueryResult, TxnState } from '@shared/protocol';
import { armProdGate, evaluateGate } from './session-prod-gate';
import { looksLikeDdl } from './session-sql-heuristics';
import {
  activeTab,
  defaultActiveResultIndex,
  mergeNotices,
  patchActiveTab,
  patchTabById,
  resultPatch,
} from './session-tab-model';
import { reloadTableTab } from './session-table-query';
import type { QueryTab, SliceCreator } from './session-types';
import { useWorkbench } from './workbench';

/** F11: streamed notices kept per tab run (the worker adds a "+N more" note). */
const MAX_TAB_NOTICES = 2_000;

export interface QuerySlice {
  txnState: TxnState;
  setSql(sql: string): void;
  /**
   * Execute SQL for the active tab.
   * - default / `{ all: false }`: selection if non-empty, else statement at cursor (U24)
   * - `{ all: true }`: whole buffer (⌘⇧⏎)
   * - `{ sql, base? }`: run this exact script (prod-gate resume); skips caret resolution
   */
  runQuery(opts?: { all?: boolean; mode?: RunMode; sql?: string; base?: number }): Promise<void>;
  /** Switch the grid to another statement result from the last multi-result run (U26). */
  setActiveResultIndex(index: number): void;
  /** ⌥← / ⌥→ — cycle the statement switcher. */
  cycleActiveResult(delta: -1 | 1): void;
  /** Append a streamed Postgres NOTICE to the origin tab of the in-flight run. */
  appendPgNotice(notice: PgNotice): void;
  cancelQuery(): Promise<void>;
  // Transactions
  beginTxn(): Promise<void>;
  commitTxn(): Promise<void>;
  rollbackTxn(): Promise<void>;
  // SQL formatting (calls main → sql-formatter → back). Replaces the
  // active tab's SQL on success; no-op for table tabs (their SQL is
  // compiled, not user-edited).
  formatActiveSql(): Promise<void>;
}

export const createQuerySlice: SliceCreator<QuerySlice> = (set, get) => ({
  txnState: 'none',

  setSql(sql) {
    patchActiveTab(set, get, { sql });
  },

  async runQuery(opts?: { all?: boolean; mode?: RunMode; sql?: string; base?: number }) {
    const state = get();
    const tab = activeTab(state);
    if (!tab) return;
    if (tab.queryRunState === 'running') return;

    // Table tabs compile their SQL from structured state.
    if (tab.kind === 'table') {
      await reloadTableTab(set, get, tab.id);
      return;
    }

    // U24: ⌘⏎ = selection else statement-at-cursor; ⌘⇧⏎ = whole buffer.
    // Menu Run without an editor caret falls back to the whole buffer.
    // Prod-gate confirm passes `{ sql }` so the approved payload runs once.
    let script: string;
    let base: number;
    if (opts?.sql != null) {
      script = opts.sql;
      base = opts.base ?? 0;
      if (script.trim().length === 0) return;
    } else {
      const mode: RunMode = opts?.mode ?? (opts?.all ? 'buffer' : 'smart');
      // Only trust this tab's caret, and only if it was read from the
      // current text — otherwise its offsets point into different SQL.
      const saved = useWorkbench.getState().carets[tab.id];
      const caret = saved && saved.bufferLength === tab.sql.length ? saved : null;
      const target = resolveRunTarget(tab.sql, mode, caret);
      if (!target) return;
      script = target.sql;
      base = target.base;
    }

    // Prod gate: if active connection is tagged 'prod' and the script
    // includes any destructive statement, stash the SQL and prompt for
    // confirmation. The user resumes via `confirmProdGate()` with `{ sql }`,
    // which skips this check so the approved payload executes once.
    if (opts?.sql == null) {
      const decision = evaluateGate(get, script);
      if (decision.kind === 'refuse') {
        patchTabById(set, tab.id, {
          queryRunState: 'idle',
          queryError: decision.message,
          queryErrorSql: script,
          queryErrorRange: null,
        });
        return;
      }
      if (decision.kind === 'confirm' && state.prodGate === null) {
        armProdGate(set, get, { sql: script, tabId: tab.id, reason: decision.reason });
        return;
      }
    }

    // U03/U26: capture origin tab + generation before any await so results /
    // errors / notices publish only to that tab (not whichever is active later).
    const originTabId = tab.id;
    const originConnGen = state.connectionGen ?? 0;
    const generation = (tab.queryGeneration ?? 0) + 1;
    patchTabById(set, originTabId, {
      queryRunState: 'running',
      queryError: null,
      queryErrorSql: null,
      queryErrorRange: null,
      queryRunningRange: null,
      queryGeneration: generation,
      runStartedAt: Date.now(),
      queryResults: [],
      activeResultIndex: 0,
      queryResult: null,
      queryNotices: [],
    });

    const publishOrigin = (patch: Partial<QueryTab>) => {
      const current = get().tabs.find((t) => t.id === originTabId);
      if (!current || current.queryGeneration !== generation) return;
      if ((get().connectionGen ?? 0) !== originConnGen) {
        patchTabById(set, originTabId, {
          queryRunState: 'idle',
          queryError: 'connection changed while query was running — result discarded',
        });
        return;
      }
      patchTabById(set, originTabId, patch);
    };

    // Multi-statement scripts: split with a quote/comment-aware tokenizer
    // and run each separately. Collect every QueryResult for the statement
    // switcher / messages strip (U26). Failures stop execution and surface
    // "stopped at N of M". Offsets remap into the full tab buffer for Monaco.
    const statements = splitSqlStatements(script).map((s) => ({
      text: s.text,
      start: base + s.start,
      end: base + s.end,
    }));
    try {
      const results: QueryResult[] = [];
      let anyDdl = false;
      for (let i = 0; i < statements.length; i++) {
        const stmt = statements[i]!;
        publishOrigin({
          queryRunningRange: { start: stmt.start, end: stmt.end },
        });
        try {
          // Editor row limit (TablePlus "No limit" menu) — enforced in the
          // worker's cursor read, so the SQL itself is never rewritten.
          const rowLimit = useWorkbench.getState().rowLimit;
          const unsupported = unsupportedStatementReason(stmt.text);
          if (unsupported) throw new Error(unsupported);
          const result =
            rowLimit === null
              ? await ipc.query.run(stmt.text)
              : await ipc.query.run(stmt.text, undefined, { maxRows: rowLimit });
          // Attach any streamed notices that arrived for this statement
          // index (driver also returns notices; merge uniquely by message).
          const current = get().tabs.find((t) => t.id === originTabId);
          const streamed = (
            (current?.queryNotices ?? []) as Array<{ statementIndex: number; notice: PgNotice }>
          )
            .filter((n) => n.statementIndex === i)
            .map((n) => n.notice);
          const merged = mergeNotices(result.notices, streamed);
          results.push(
            merged.length > 0
              ? { ...result, notices: merged, sql: stmt.text }
              : { ...result, sql: stmt.text },
          );
          // F4/F9: the worker reports the server's real transaction status.
          if (result.txnState && (get().connectionGen ?? 0) === originConnGen) {
            set({ txnState: result.txnState });
          }
          // Progressive reveal: keep the latest result visible while the rest run.
          publishOrigin({
            ...resultPatch(results, defaultActiveResultIndex(results)),
            page: 0,
            sortColumn: null,
            selectedCell: null,
            selectedRows: new Set(),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const tag = statements.length > 1 ? ` (statement ${i + 1} of ${statements.length})` : '';
          // An error inside a transaction block aborts it (E). With
          // Transaction mode on, the worker had BEGUN before the statement.
          if (
            (get().connectionGen ?? 0) === originConnGen &&
            (get().txnState === 'active' || get().settings.transactionMode)
          ) {
            set({ txnState: 'error' });
          }
          publishOrigin({
            ...resultPatch(results, defaultActiveResultIndex(results)),
            queryError: `${message}${tag}`,
            queryErrorSql: stmt.text,
            queryErrorRange: { start: stmt.start, end: stmt.end },
            queryRunningRange: null,
            queryRunState: 'idle',
          });
          if (anyDdl) void get().refreshSchema();
          return;
        }
        if (looksLikeDdl(stmt.text)) anyDdl = true;
      }
      publishOrigin({
        ...resultPatch(results, defaultActiveResultIndex(results)),
        queryRunState: 'idle',
        queryRunningRange: null,
        page: 0,
        sortColumn: null,
        selectedCell: null,
        selectedRows: new Set(),
      });
      if (anyDdl) {
        void get().refreshSchema();
      }
    } catch (err) {
      publishOrigin({
        queryError: err instanceof Error ? err.message : String(err),
        queryErrorSql: script,
        queryErrorRange:
          statements.length > 0
            ? { start: statements[0]!.start, end: statements[statements.length - 1]!.end }
            : null,
        queryRunningRange: null,
        queryRunState: 'idle',
      });
    }
  },

  setActiveResultIndex(index) {
    const tab = activeTab(get());
    if (!tab || tab.queryResults.length === 0) return;
    const clamped = Math.max(0, Math.min(index, tab.queryResults.length - 1));
    if (clamped === tab.activeResultIndex) return;
    patchActiveTab(set, get, {
      ...resultPatch(tab.queryResults, clamped),
      page: 0,
      sortColumn: null,
      selectedCell: null,
      selectedRows: new Set(),
    });
  },

  cycleActiveResult(delta) {
    const tab = activeTab(get());
    if (!tab || tab.queryResults.length <= 1) return;
    const next =
      (tab.activeResultIndex + delta + tab.queryResults.length) % tab.queryResults.length;
    get().setActiveResultIndex(next);
  },

  appendPgNotice(notice) {
    // Attach to the tab that is currently running a SQL script. Prefer a
    // running tab over the active one so a focus change mid-run still lands
    // notices on the origin (U03 + U26).
    const state = get();
    const running =
      state.tabs.find((t) => t.queryRunState === 'running' && t.kind === 'sql') ?? activeTab(state);
    if (!running || running.kind !== 'sql') return;
    // F11: the worker caps notices per statement too; this bounds the
    // renderer's copy-on-append so a NOTICE flood can't freeze the UI.
    if (running.queryNotices.length >= MAX_TAB_NOTICES) return;
    const statementIndex = running.queryResults.length; // next / in-flight index
    patchTabById(set, running.id, {
      queryNotices: [...running.queryNotices, { statementIndex, notice }],
    });
  },

  async cancelQuery() {
    try {
      await ipc.query.cancel();
    } catch (err) {
      console.error('[plasma] cancel failed', err);
    }
  },

  // ── transactions ──

  async beginTxn() {
    try {
      const state = await ipc.txn.begin();
      set({ txnState: state });
    } catch (err) {
      console.error('[plasma] beginTxn failed', err);
    }
  },

  async commitTxn() {
    try {
      const state = await ipc.txn.commit();
      set({ txnState: state });
    } catch (err) {
      console.error('[plasma] commitTxn failed', err);
    }
  },

  async rollbackTxn() {
    try {
      const state = await ipc.txn.rollback();
      set({ txnState: state });
    } catch (err) {
      console.error('[plasma] rollbackTxn failed', err);
    }
  },

  // ── SQL formatting ──

  async formatActiveSql() {
    const tab = activeTab(get());
    if (!tab || tab.kind !== 'sql') return;
    if (!tab.sql.trim()) return;
    try {
      const formatted = await ipc.sql.format(tab.sql);
      if (formatted && formatted !== tab.sql) {
        set({ tabs: get().tabs.map((t) => (t.id === tab.id ? { ...t, sql: formatted } : t)) });
      }
    } catch (err) {
      console.error('[plasma] formatActiveSql failed', err);
    }
  },
});
