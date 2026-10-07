/**
 * Query slice: the editor's run pipeline (multi-statement scripts, prod
 * gate, origin-tab publishing), result switching, NOTICE streaming,
 * formatting and the explicit transaction controls.
 */
import { isAiApplied } from '@/lib/ai-applied';
import { cleanIpcError } from '@/lib/errors';
import { ipc } from '@/lib/ipc';
import {
  inlineVariables,
  listVariables,
  mergeVariableHistory,
  runBound,
  variableProblem,
} from '@/lib/query-variables';
import { shouldAutoSafeRun } from '@/lib/safe-run';
import {
  type RunMode,
  resolveRunTarget,
  splitSqlStatements,
  unsupportedStatementReason,
} from '@/lib/sql-split';
import type { CancelOutcome, PgNotice, QueryResult, TxnState } from '@shared/protocol';
import {
  CANCELLED_NOTE,
  type LifecycleEvent,
  type QueryLifecycle,
  endsTransaction,
  holdsPrimary,
  reduceLifecycle,
} from '@shared/query-lifecycle';
import { armProdGate, evaluateGate } from './session-prod-gate';
import { safeRunPending } from './session-safe-run';
import { looksLikeDdl, looksLikeWrite } from './session-sql-heuristics';
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

/**
 * Runs waiting for the primary connection. A queued run is NOT sent to the
 * worker: its request is held here until the tab ahead settles, so it can be
 * withdrawn (Cancel, closing the tab, a connection change) without ever running.
 */
const turnWaiters = new Map<string, { generation: number; release(go: boolean): void }>();

/** Cancel requested for a run (`tabId:generation`); checked between a script's statements. */
const cancelRequested = new Set<string>();

/** Tunables the tests shorten. */
export const cancelTuning = { retryMs: 250, retries: 4 };

/** Release or drop queue waiters whose tab moved on. */
function settleWaiters(tabs: QueryTab[]): void {
  for (const [tabId, w] of [...turnWaiters]) {
    const t = tabs.find((x) => x.id === tabId);
    const phase = t?.queryLifecycle?.phase;
    if (!t || t.queryGeneration !== w.generation) {
      turnWaiters.delete(tabId);
      w.release(false);
    } else if (phase === 'running') {
      turnWaiters.delete(tabId);
      w.release(true);
    } else if (phase !== 'queued') {
      turnWaiters.delete(tabId);
      w.release(false);
    }
  }
}

/** Queued runs start as soon as the tab holding the connection settles. */
export function promoteQueuedTabs(tabs: QueryTab[], now: number): QueryTab[] | null {
  const busy = tabs.some((t) => holdsPrimary(t.queryLifecycle));
  if (busy) return null;
  const next = tabs
    .filter((t) => t.queryLifecycle?.phase === 'queued')
    .sort((a, b) => a.queryLifecycle!.since - b.queryLifecycle!.since)[0];
  if (!next) return null;
  return tabs.map((t) =>
    t.id === next.id
      ? { ...t, queryLifecycle: reduceLifecycle(t.queryLifecycle!, { type: 'begin', now }) }
      : t,
  );
}

export const createQuerySlice: SliceCreator<QuerySlice> = (set, get, api) => {
  api.subscribe((state) => {
    const promoted = promoteQueuedTabs(state.tabs, Date.now());
    if (promoted) set({ tabs: promoted });
    settleWaiters(promoted ?? state.tabs);
  });
  return {
    txnState: 'none',

    setSql(sql) {
      const tab = activeTab(get());
      // R-15: offsets of the last error / running statement refer to the OLD
      // text — once the buffer changes they would mark unrelated characters.
      const stale =
        tab && tab.sql !== sql && (tab.queryErrorRange != null || tab.queryRunningRange != null);
      patchActiveTab(
        set,
        get,
        stale ? { sql, queryErrorRange: null, queryRunningRange: null } : { sql },
      );
    },

    async runQuery(opts?: { all?: boolean; mode?: RunMode; sql?: string; base?: number }) {
      const state = get();
      const tab = activeTab(state);
      if (!tab) return;
      if (tab.queryRunState === 'running') return;

      // A Safe Run holds the primary connection until it is committed or rolled back.
      if (safeRunPending(state.safeRun)) {
        get().noteSafeRunBlocked(tab.id);
        return;
      }

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

      // Query variables (:name, :'name', $name): the first run with variables
      // (and any run with a missing or invalid value) opens the Variables bar
      // above the results instead of running. Values bind as real parameters
      // per statement below; the gate sees them written out, so what it
      // classifies and shows is exactly what would run.
      const varNames = listVariables(script);
      const varValues = tab.queryVars ?? {};
      if (varNames.length > 0) {
        const problem = variableProblem(script, varValues);
        if (problem || tab.varsReviewed !== true) {
          patchTabById(set, tab.id, { varsBarOpen: true, varsAttention: problem });
          return;
        }
      }
      const gateScript = varNames.length > 0 ? inlineVariables(script, varValues) : script;
      if (varNames.length > 0) {
        const before = state.settings.variableHistory ?? {};
        const after = mergeVariableHistory(before, varNames, varValues);
        if (after !== before) void get().updateSettings({ variableHistory: after });
      }

      // Prod gate: if active connection is tagged 'prod' and the script
      // includes any destructive statement, stash the SQL and prompt for
      // confirmation. The user resumes via `confirmProdGate()` with `{ sql }`,
      // which skips this check so the approved payload executes once.
      if (opts?.sql == null) {
        const decision = evaluateGate(get, gateScript);
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
          armProdGate(set, get, { sql: gateScript, tabId: tab.id, reason: decision.reason, base });
          return;
        }
      }

      // Safe Run: connections that always dry-run writes (default for Prod)
      // send a single INSERT / UPDATE / DELETE / MERGE through it. The gate
      // above already ran, so the review starts without asking twice.
      if (state.safeRun) set({ safeRun: null });
      if (
        shouldAutoSafeRun({
          settings: state.settings,
          connectionId: state.activeConfig?.id,
          engine: state.activeConfig?.engine,
          readOnly: state.activeConfig?.readOnly,
          sql: gateScript,
        })
      ) {
        void get().runSafeRun({ sql: gateScript, base, gated: true });
        return;
      }

      // U03/U26: capture origin tab + generation before any await so results /
      // errors / notices publish only to that tab (not whichever is active later).
      const originTabId = tab.id;
      const originConnGen = state.connectionGen ?? 0;
      const generation = (tab.queryGeneration ?? 0) + 1;
      // Another tab already holds the connection: this run waits its turn.
      const busyElsewhere = state.tabs.some(
        (t) => t.id !== originTabId && holdsPrimary(t.queryLifecycle),
      );
      const startedAt = Date.now();
      patchTabById(set, originTabId, {
        queryRunState: 'running',
        queryLifecycle: busyElsewhere
          ? { phase: 'queued', since: startedAt }
          : { phase: 'running', since: startedAt, startedAt },
        queryError: null,
        queryErrorSql: null,
        queryErrorRange: null,
        queryRunningRange: null,
        queryGeneration: generation,
        runStartedAt: startedAt,
        queryResults: [],
        activeResultIndex: 0,
        queryResult: null,
        queryNotices: [],
      });

      const cancelKey = `${originTabId}:${generation}`;
      cancelRequested.delete(cancelKey);
      if (busyElsewhere) {
        // Hold the request until the connection is free. Anything that moves the
        // tab on (cancel, close, re-run, connection change) releases it with `false`.
        const go = await new Promise<boolean>((release) => {
          turnWaiters.get(originTabId)?.release(false);
          turnWaiters.set(originTabId, { generation, release });
          settleWaiters(get().tabs);
        });
        if (!go) return;
      }

      const engine = state.activeConfig?.engine;
      /** The statement ends a transaction, or implicitly commits (MySQL DDL). */
      const commitLike = (sql: string) =>
        endsTransaction(sql) || (engine === 'mysql' && looksLikeDdl(sql));
      // The statement being sent, so a lost connection can tell a read from a
      // write whose outcome is unknown.
      let sentSql = script;
      const settle = (event: LifecycleEvent): QueryLifecycle =>
        reduceLifecycle(
          get().tabs.find((t) => t.id === originTabId)?.queryLifecycle ?? {
            phase: 'running',
            since: startedAt,
            startedAt,
          },
          event,
        );
      const publishOrigin = (patch: Partial<QueryTab>) => {
        const current = get().tabs.find((t) => t.id === originTabId);
        if (!current || current.queryGeneration !== generation) return;
        if ((get().connectionGen ?? 0) !== originConnGen) {
          patchTabById(set, originTabId, {
            queryRunState: 'idle',
            queryLifecycle: settle({
              type: 'fail',
              now: Date.now(),
              message: 'connection lost: the connection changed while the query was running',
              isWrite: looksLikeWrite(sentSql),
              commitLike: commitLike(sentSql),
              sql: sentSql,
            }),
            queryError:
              current.queryError || 'connection changed while query was running — result discarded',
          });
          return;
        }
        // First result of a run that was waiting its turn: it is running now.
        if (current.queryLifecycle?.phase === 'queued' && 'queryResult' in patch) {
          patchTabById(set, originTabId, {
            queryLifecycle: settle({ type: 'begin', now: Date.now() }),
          });
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
          // R-13: never issue the rest of a script on a different connection
          // (or for a tab that was closed / re-run) than it started on.
          if (i > 0) {
            const current = get().tabs.find((t) => t.id === originTabId);
            if (!current || current.queryGeneration !== generation) return;
            if ((get().connectionGen ?? 0) !== originConnGen) {
              publishOrigin({});
              return;
            }
          }
          // A cancel that landed between statements: stop here, do not send the rest.
          if (i > 0 && cancelRequested.has(cancelKey)) {
            const note = `Cancelled. ${i} of ${statements.length} statements ran; the rest did not.`;
            const lifecycle = {
              ...settle({ type: 'fail', now: Date.now(), message: note }),
              message: note,
            };
            publishOrigin({
              ...resultPatch(results, defaultActiveResultIndex(results)),
              queryError: note,
              queryErrorSql: stmt.text,
              queryErrorRange: { start: stmt.start, end: stmt.end },
              queryRunningRange: null,
              queryRunState: 'idle',
              queryLifecycle: lifecycle,
            });
            if (anyDdl) void get().refreshSchema();
            return;
          }
          sentSql = stmt.text;
          publishOrigin({
            queryRunningRange: { start: stmt.start, end: stmt.end },
            queryRunningSql: stmt.text,
          });
          try {
            // Editor row limit (TablePlus "No limit" menu) — enforced in the
            // worker's cursor read, so the SQL itself is never rewritten.
            const rowLimit = useWorkbench.getState().rowLimit;
            const unsupported = unsupportedStatementReason(stmt.text);
            if (unsupported) throw new Error(unsupported);
            const auditSource = isAiApplied(originTabId, stmt.text) ? ('ai' as const) : undefined;
            const result = await runBound(stmt.text, varValues, (sql, params) => {
              if (rowLimit !== null || auditSource) {
                return ipc.query.run(sql, params, {
                  ...(rowLimit !== null ? { maxRows: rowLimit } : {}),
                  ...(auditSource ? { auditSource } : {}),
                });
              }
              return params ? ipc.query.run(sql, params) : ipc.query.run(sql);
            });
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
            const tag =
              statements.length > 1 ? ` (statement ${i + 1} of ${statements.length})` : '';
            // An error inside a transaction block aborts it (E). With
            // Transaction mode on, the worker had BEGUN before the statement.
            if (
              (get().connectionGen ?? 0) === originConnGen &&
              (get().txnState === 'active' || get().settings.transactionMode)
            ) {
              set({ txnState: 'error' });
            }
            const lifecycle = settle({
              type: 'fail',
              now: Date.now(),
              message: cleanIpcError(message),
              isWrite: looksLikeWrite(stmt.text),
              commitLike: commitLike(stmt.text),
              sql: stmt.text,
            });
            const cancelledText =
              statements.length > 1
                ? `Cancelled during statement ${i + 1} of ${statements.length}. ${i} ran before it.`
                : CANCELLED_NOTE;
            publishOrigin({
              ...resultPatch(results, defaultActiveResultIndex(results)),
              queryError:
                lifecycle.phase === 'cancelled'
                  ? cancelledText
                  : lifecycle.phase === 'unknown' || lifecycle.phase === 'disconnected'
                    ? `${lifecycle.message}${tag}`
                    : `${message}${tag}`,
              queryErrorSql: stmt.text,
              queryErrorRange: { start: stmt.start, end: stmt.end },
              queryRunningRange: null,
              queryRunState: 'idle',
              queryLifecycle: lifecycle,
            });
            if (anyDdl) void get().refreshSchema();
            return;
          }
          if (looksLikeDdl(stmt.text)) anyDdl = true;
        }
        publishOrigin({
          ...resultPatch(results, defaultActiveResultIndex(results)),
          queryRunState: 'idle',
          queryLifecycle: settle({ type: 'succeed', now: Date.now() }),
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
        const message = err instanceof Error ? err.message : String(err);
        cancelRequested.delete(cancelKey);
        publishOrigin({
          queryLifecycle: settle({
            type: 'fail',
            now: Date.now(),
            message: cleanIpcError(message),
            isWrite: looksLikeWrite(sentSql),
            commitLike: commitLike(sentSql),
            sql: sentSql,
          }),
          queryError: message,
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
        state.tabs.find((t) => t.queryRunState === 'running' && t.kind === 'sql') ??
        activeTab(state);
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
      // Cancel stops this tab's own run on its own connection, nothing else.
      const state = get();
      const tab = activeTab(state);
      const life = tab?.queryLifecycle;
      if (!tab || !life) return;
      const tabId = tab.id;
      const generation = tab.queryGeneration;
      const stillOurs = () => {
        const cur = get().tabs.find((t) => t.id === tabId);
        return cur?.queryGeneration === generation && cur?.queryLifecycle?.phase === 'cancelling';
      };
      const apply = (event: LifecycleEvent) => {
        const cur = get().tabs.find((t) => t.id === tabId);
        // A newer run on this tab must not inherit an old cancel's outcome.
        if (!cur?.queryLifecycle || cur.queryGeneration !== generation) return;
        const next = reduceLifecycle(cur.queryLifecycle, event);
        if (next !== cur.queryLifecycle) patchTabById(set, cur.id, { queryLifecycle: next });
      };

      // Waiting its turn: nothing was sent, so withdrawing it is enough.
      if (life.phase === 'queued') {
        const note = 'Cancelled before it started. Nothing was sent to the server.';
        patchTabById(set, tabId, {
          queryRunState: 'idle',
          queryLifecycle: { phase: 'cancelled', since: Date.now(), message: note },
          queryError: note,
          queryErrorSql: null,
        });
        return;
      }
      if (life.phase !== 'running' && life.phase !== 'cancelling') return;

      cancelRequested.add(`${tabId}:${generation}`);
      if (life.phase === 'running') apply({ type: 'cancel', now: Date.now() });
      const fail = (message: string) => apply({ type: 'cancelFailed', now: Date.now(), message });
      try {
        // An AI read runs on the aux connection: only that is stopped.
        if (life.aux) {
          await ipc.query.cancelAux();
          return;
        }
        let outcome: CancelOutcome = await ipc.query.cancel();
        // Nothing in flight yet (the statement is still on its way, or a script is
        // between two statements): try again shortly instead of letting it run.
        for (
          let n = 0;
          outcome === 'nothing-running' && n < cancelTuning.retries && stillOurs();
          n++
        ) {
          await new Promise((r) => setTimeout(r, cancelTuning.retryMs));
          if (!stillOurs()) return;
          outcome = await ipc.query.cancel();
        }
        if (outcome === 'unsupported') fail('This engine cannot stop a running statement.');
        else if (outcome === 'failed') {
          fail('The server did not confirm the cancel. Try again, or disconnect to stop it.');
        }
      } catch (err) {
        console.error('[plasma] cancel failed', err);
        fail('Could not reach the server to cancel.');
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
  };
};
