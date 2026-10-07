/**
 * The agent's action cards (AI panel). The model proposes an action; main
 * sends it here as an `action` event and waits for the user's decision.
 *
 * Nothing runs without the click: `handleActionEvent` only validates and
 * shows a card (or, for view changes with the "apply without asking" setting,
 * applies the view). Everything that writes goes through the normal paths:
 * Safe Run on Postgres, `runQuery` (prod gate, safe mode, read-only guard)
 * otherwise. Every card ends in exactly one result sent back to main.
 */
import { applyTableView, restoreTableView } from '@/features/ai/table-view-apply';
import { markAiApplied } from '@/lib/ai-applied';
import { ipc } from '@/lib/ipc';
import { isSafeRunnable } from '@/lib/safe-run';
import {
  type AgentActionInput,
  type AgentActionStatus,
  normalizeAction,
} from '@shared/agent-actions';
import { agentReadSandboxed, isAgentReadSql } from '@shared/ai-readonly-sql';
import { isAiSchemaAllowed } from '@shared/ai-schema-policy';
import type { AiActionResult, AiChatEvent, QueryResult } from '@shared/protocol';
import { isSqlEngine } from '@shared/sql-dialect';
import { closeColumnNames, mergeHiddenFilterValues, validateTableView } from '@shared/table-view';
import type { StoreApi } from 'zustand';
import { errorText } from './session-connection';
import { SAFE_RUN_BLOCKED_NOTE, safeRunPending } from './session-safe-run';
import { activeTab, freshId, patchTabById, resultPatch } from './session-tab-model';
import type { AgentAction, AiPart, SessionState } from './session-types';

type ActionEvent = Extract<AiChatEvent, { kind: 'action' }>;
type Outcome = AiActionResult['outcome'];

/** Rows of a result that go back to main (it caps and gates them again). */
const RESULT_ROWS = 50;
const CELL_CHARS = 500;

const isOpen = (a: AgentAction | undefined): a is AgentAction =>
  a !== undefined && (a.status === 'pending' || a.status === 'running');

/** A cell as something that survives IPC and JSON: no bigint, no binary, bounded text. */
function safeCell(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string') return v.length > CELL_CHARS ? `${v.slice(0, CELL_CHARS)}…` : v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (v instanceof Uint8Array) return '[binary]';
  try {
    const text = JSON.stringify(v);
    if (text === undefined) return null;
    return text.length > CELL_CHARS ? `${text.slice(0, CELL_CHARS)}…` : v;
  } catch {
    return String(v).slice(0, CELL_CHARS);
  }
}

export function resultData(r: QueryResult): NonNullable<AiActionResult['data']> {
  return {
    columns: r.columns.map((c) => c.name),
    rows: r.rows.slice(0, RESULT_ROWS).map((row) => row.map(safeCell)),
    rowCount: r.rowCount,
  };
}

/** What a model-proposed action looked like, so a rejected call still gets a (failed) card. */
function fallbackAction(name: string, args: Record<string, unknown>): AgentActionInput {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (name) {
    case 'show_table':
      return { name, schema: str(args.schema), table: str(args.table), rawView: {} };
    case 'run_query':
      return { name, sql: str(args.sql) };
    case 'propose_change':
      return { name, sql: str(args.sql), summary: str(args.summary) };
    default:
      return { name: 'open_in_editor', sql: str(args.sql) };
  }
}

/** One `rowsAffected` line for the card and the model. */
function affectedNote(r: QueryResult): string {
  if (r.columns.length > 0) return `${r.rowCount} row${r.rowCount === 1 ? '' : 's'}`;
  if (r.command && r.rowCount === 0) return `${r.command} done`;
  return `${r.rowCount} row${r.rowCount === 1 ? '' : 's'} affected`;
}

export interface AgentActionApi {
  handleActionEvent(evt: ActionEvent): Promise<void>;
  approve(id: string): Promise<void>;
  reject(id: string, note?: string): void;
  undo(id: string): Promise<void>;
  /** Every open card becomes cancelled. `send: false` when main already knows (Stop / error). */
  cancelAll(reason: string, opts?: { send?: boolean }): void;
}

export function createAgentActions(api: StoreApi<SessionState>): AgentActionApi {
  const get = api.getState;
  const set = api.setState as (fn: (s: SessionState) => Partial<SessionState>) => void;

  const patch = (id: string, p: Partial<AgentAction>) =>
    set((s) => {
      const cur = s.aiActions[id];
      return cur ? { aiActions: { ...s.aiActions, [id]: { ...cur, ...p } } } : {};
    });

  /** Update the one-line status only when it changes (store listeners react to every write). */
  const setNote = (id: string, note: string) => {
    if (get().aiActions[id]?.note !== note) patch(id, { note });
  };

  const send = (a: AgentAction, outcome: Outcome, note?: string, data?: AiActionResult['data']) => {
    void ipc.ai
      .actionResult({
        requestId: a.requestId,
        callId: a.callId,
        outcome,
        ...(note ? { note: note.slice(0, 2000) } : {}),
        ...(a.dbError ? { dbError: a.dbError.slice(0, 4000) } : {}),
        ...(data ? { data } : {}),
      })
      .catch(() => undefined);
  };

  /** Close a card with its final status and answer main. A card closes once. */
  const settle = (
    id: string,
    status: Exclude<AgentActionStatus, 'pending' | 'running'>,
    note?: string,
    data?: AiActionResult['data'],
    extra: Partial<AgentAction> = {},
    opts: { send?: boolean } = {},
  ): boolean => {
    const a = get().aiActions[id];
    if (!isOpen(a)) return false;
    patch(id, { ...extra, status, note });
    if (opts.send !== false) send({ ...a, ...extra }, status, note, data);
    return true;
  };

  /** A failure that came from the database: the card shows it, the model gets a value-free reason. */
  const failDb = (id: string, message: string, extra: Partial<AgentAction> = {}) =>
    settle(id, 'failed', message, undefined, { ...extra, dbError: message });

  /** Resolves when `pred` holds on the store, or the card is no longer open. */
  const waitFor = (id: string, pred: (s: SessionState) => boolean): Promise<void> =>
    new Promise((resolve) => {
      const done = (s: SessionState) => pred(s) || !isOpen(s.aiActions[id]);
      if (done(get())) return resolve();
      const unsub = api.subscribe((s) => {
        if (!done(s)) return;
        unsub();
        resolve();
      });
    });
  const nextTick = () => new Promise<void>((r) => setTimeout(r, 0));

  /** New card in the turn being streamed, in order with its text. */
  const addCard = (card: AgentAction) => {
    set((s) => {
      const idx = s.aiChat.map((t) => t.streaming && t.role === 'assistant').lastIndexOf(true);
      const part: AiPart = { kind: 'action', actionId: card.id };
      return {
        aiActions: { ...s.aiActions, [card.id]: card },
        aiChat:
          idx === -1
            ? s.aiChat
            : s.aiChat.map((t, i) => (i === idx ? { ...t, parts: [...(t.parts ?? []), part] } : t)),
      };
    });
  };

  const failedCard = (evt: ActionEvent, action: AgentActionInput, reason: string) => {
    const card: AgentAction = {
      id: freshId(),
      requestId: evt.requestId,
      callId: evt.callId,
      name: evt.name,
      action,
      status: 'failed',
      note: reason,
    };
    addCard(card);
    send(card, 'failed', reason);
  };

  /** The new tab for SQL the agent put there: never over a tab with content. */
  const openSqlTab = (sql: string, title?: string): string => {
    const st = get();
    const cur = activeTab(st);
    let tabId: string;
    if (cur && cur.kind === 'sql' && cur.sql.trim().length === 0) {
      st.setSql(sql);
      tabId = cur.id;
    } else {
      tabId = st.openSqlInNewTab(sql, title ? { title } : undefined);
    }
    markAiApplied(tabId, sql);
    return tabId;
  };

  const sameConnection = (): boolean => {
    const s = get();
    return (
      s.connectionState === 'connected' &&
      s.activeConfig != null &&
      s.activeConfig.id === s.aiChatConnectionId &&
      isSqlEngine(s.activeConfig.engine)
    );
  };

  /** Wait for the run the agent started in `tabId` and report how it went. */
  const finishRun = async (
    id: string,
    tabId: string,
    startGen: number,
    describe: (r: QueryResult) => string,
    withData: boolean,
    write = false,
  ): Promise<void> => {
    const ran = (s: SessionState) => {
      const t = s.tabs.find((x) => x.id === tabId);
      return !t || ((t.queryGeneration ?? 0) > startGen && t.queryRunState === 'idle');
    };
    let tab = get().tabs.find((t) => t.id === tabId);
    if (tab && (tab.queryGeneration ?? 0) <= startGen) {
      // Did not start. A confirmation may be open: the run continues when the user answers it.
      if (get().prodGate?.tabId === tabId) {
        await waitFor(id, (s) => ran(s) || s.prodGate?.tabId !== tabId);
        await nextTick(); // confirming hands over to the run in the same tick
        if (!isOpen(get().aiActions[id])) return;
        tab = get().tabs.find((t) => t.id === tabId);
        if (tab && (tab.queryGeneration ?? 0) <= startGen) {
          settle(id, 'rejected', 'The user declined the confirmation. Nothing ran.');
          return;
        }
        await waitFor(id, ran);
      } else if (tab.queryError) {
        failDb(id, tab.queryError);
        return;
      } else if (tab.varsBarOpen) {
        settle(
          id,
          'failed',
          'The query uses variables. Nothing ran: fill them in and run it from the tab.',
        );
        return;
      } else {
        settle(id, 'failed', 'The query did not run.');
        return;
      }
    }
    if (!isOpen(get().aiActions[id])) return;
    tab = get().tabs.find((t) => t.id === tabId);
    if (!tab) {
      settle(id, 'cancelled', 'The tab was closed before the query finished.');
    } else if (tab.queryError) {
      failDb(id, tab.queryError);
    } else if (tab.queryResult) {
      const r = tab.queryResult as QueryResult;
      // Transaction mode: the statement ran inside a transaction nobody committed.
      const open =
        write && get().txnState === 'active'
          ? ' It ran inside an open transaction and is NOT committed yet: commit or roll back in the editor.'
          : '';
      settle(
        id,
        'applied',
        `${describe(r)}${open}`,
        withData || r.columns.length > 0 ? resultData(r) : undefined,
      );
    } else {
      settle(id, 'failed', 'The query returned no result.');
    }
  };

  /** Follow a Safe Run started for a card until it ends. */
  const trackSafeRun = (id: string, tabId: string, prevToken: number | undefined): void => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let sawGate = false;
    let sawRun = false;
    const evaluate = (state: SessionState): boolean => {
      // true = finished, stop listening
      const a = state.aiActions[id];
      if (!isOpen(a)) return true;
      const sr = state.safeRun;
      if (sr && sr.tabId === tabId && sr.token !== prevToken) {
        sawRun = true;
        switch (sr.phase) {
          case 'running':
            setNote(id, 'Running the preview…');
            return false;
          case 'review':
            setNote(
              id,
              'Preview ready. Review it in the Safe Run panel, then commit or roll back.',
            );
            return false;
          case 'finishing':
            setNote(id, 'Finishing…');
            return false;
          case 'committed':
            settle(
              id,
              'applied',
              `Committed: ${sr.report?.affected ?? 0} row${sr.report?.affected === 1 ? '' : 's'} affected.`,
            );
            return true;
          case 'rolledBack':
            if (sr.endReason === 'timeout') {
              settle(
                id,
                'failed',
                'The review window ran out and the change was rolled back. Nothing changed.',
              );
            } else if (sr.endReason === 'user') {
              settle(id, 'rejected', 'The user rolled back the preview. Nothing changed.');
            } else {
              settle(
                id,
                'cancelled',
                'The connection changed; the preview was rolled back. Nothing changed.',
              );
            }
            return true;
          case 'failed':
            failDb(id, sr.error ?? 'The preview failed.');
            return true;
        }
      }
      if (state.prodGate?.tabId === tabId) {
        sawGate = true;
        setNote(id, 'Waiting for your confirmation…');
        return false;
      }
      return false;
    };
    // The confirmation closing and the Safe Run starting are two store updates
    // in one tick: only call it declined once the tick has passed.
    const check = (state: SessionState) => {
      if (evaluate(state)) {
        unsub();
        return;
      }
      const sr = state.safeRun;
      const hasRun = sr && sr.tabId === tabId && sr.token !== prevToken;
      if (!hasRun && state.prodGate?.tabId !== tabId && !timer) {
        timer = setTimeout(() => {
          timer = null;
          const now = get();
          if (evaluate(now)) {
            unsub();
            return;
          }
          const sr2 = now.safeRun;
          const started = sr2 && sr2.tabId === tabId && sr2.token !== prevToken;
          if (!started && now.prodGate?.tabId !== tabId && isOpen(now.aiActions[id])) {
            if (sawRun) settle(id, 'rejected', 'The user closed the preview. Nothing changed.');
            else if (sawGate)
              settle(id, 'rejected', 'The user declined the confirmation. Nothing ran.');
            else settle(id, 'failed', 'The preview did not start. Nothing ran.');
            unsub();
          }
        }, 0);
      }
    };
    const unsub = api.subscribe(check);
    check(get());
  };

  /** run_query on an engine with a read-only session: main runs it there, the result lands in the tab. */
  const runReadOnly = async (id: string, tabId: string, sql: string): Promise<void> => {
    const tab0 = get().tabs.find((t) => t.id === tabId);
    if (!tab0) return;
    const gen = (tab0.queryGeneration ?? 0) + 1;
    const connGen = get().connectionGen ?? 0;
    const startedAt = Date.now();
    patchTabById(set, tabId, {
      queryRunState: 'running',
      // Runs on the aux connection: it must not make a primary run look queued,
      // and Cancel on this tab stops only this read.
      queryLifecycle: { phase: 'running', since: startedAt, startedAt, aux: true },
      queryError: null,
      queryErrorSql: null,
      queryErrorRange: null,
      queryGeneration: gen,
      runStartedAt: startedAt,
      queryResults: [],
      activeResultIndex: 0,
      queryResult: null,
      queryNotices: [],
    });
    const current = () => {
      const t = get().tabs.find((x) => x.id === tabId);
      return t && t.queryGeneration === gen && (get().connectionGen ?? 0) === connGen ? t : null;
    };
    try {
      const result = await ipc.ai.runReadOnly(sql);
      if (current()) {
        patchTabById(set, tabId, {
          ...resultPatch([{ ...result, sql }], 0),
          queryRunState: 'idle',
          page: 0,
          sortColumn: null,
          selectedCell: null,
          selectedRows: new Set(),
        });
      }
      if (!isOpen(get().aiActions[id])) return;
      if (!get().tabs.some((t) => t.id === tabId)) {
        settle(id, 'cancelled', 'The tab was closed before the query finished.');
        return;
      }
      settle(id, 'applied', affectedNote(result), resultData(result));
    } catch (err) {
      const message = errorText(err);
      if (current()) {
        patchTabById(set, tabId, {
          queryError: message,
          queryErrorSql: sql,
          queryRunState: 'idle',
        });
      }
      failDb(id, message);
    }
  };

  const runOne = async (id: string): Promise<void> => {
    const a = get().aiActions[id];
    if (!isOpen(a)) return;
    const act = a.action;
    switch (act.name) {
      case 'show_table': {
        const st = get();
        st.openTable(act.schema, act.table, { preview: false });
        const tabId = get().activeTabId;
        const tab = get().tabs.find((t) => t.id === tabId);
        if (!tab || tab.kind !== 'table' || tab.tableName !== act.table) {
          settle(id, 'failed', 'Could not open the table.');
          return;
        }
        const snapshot = await applyTableView(tabId, a.view ?? {});
        if (!isOpen(get().aiActions[id])) {
          // Stopped while the view loaded: put the old view back, nothing is left half-applied.
          await restoreTableView(tabId, snapshot);
          return;
        }
        const after = get().tabs.find((t) => t.id === tabId);
        if (!after) {
          settle(id, 'cancelled', 'The tab was closed.');
          return;
        }
        if (after.queryError) {
          failDb(id, after.queryError, { snapshot, tabId });
          return;
        }
        settle(
          id,
          'applied',
          undefined,
          after.queryResult ? resultData(after.queryResult as QueryResult) : undefined,
          { snapshot, tabId },
        );
        return;
      }
      case 'open_in_editor': {
        openSqlTab(act.sql);
        settle(id, 'applied', 'Opened in a new editor tab. Not run.');
        return;
      }
      case 'run_query': {
        if (!isAgentReadSql(act.sql)) {
          settle(id, 'failed', 'This query is not read-only. Nothing ran.');
          return;
        }
        if (safeRunPending(get().safeRun)) {
          settle(id, 'failed', SAFE_RUN_BLOCKED_NOTE);
          return;
        }
        const tabId = openSqlTab(act.sql, act.title);
        patch(id, { tabId });
        if (a.sandboxed) {
          await runReadOnly(id, tabId, act.sql);
          return;
        }
        const startGen = get().tabs.find((t) => t.id === tabId)?.queryGeneration ?? 0;
        patch(id, { startGen });
        // No read-only session on this engine: the normal run path (safe mode and prod gate apply).
        await get().runQuery({ all: true });
        await finishRun(id, tabId, startGen, affectedNote, true);
        return;
      }
      case 'propose_change': {
        if (get().activeConfig?.readOnly === true) {
          settle(id, 'failed', 'The connection is read-only. Nothing ran.');
          return;
        }
        if (safeRunPending(get().safeRun)) {
          settle(id, 'failed', SAFE_RUN_BLOCKED_NOTE);
          return;
        }
        const tabId = openSqlTab(act.sql);
        patch(id, { tabId });
        if (a.mode === 'preview') {
          const prevToken = get().safeRun?.token;
          patch(id, { safeRunPrev: prevToken });
          await get().runSafeRun({ sql: act.sql });
          trackSafeRun(id, tabId, prevToken);
          return;
        }
        const startGen = get().tabs.find((t) => t.id === tabId)?.queryGeneration ?? 0;
        patch(id, { startGen });
        await get().runQuery({ all: true });
        await finishRun(id, tabId, startGen, affectedNote, false, true);
        return;
      }
    }
  };

  const approve = async (id: string): Promise<void> => {
    const a = get().aiActions[id];
    if (!a || a.status !== 'pending') return;
    if (!sameConnection()) {
      settle(id, 'failed', 'The connection changed since this chat started. Nothing ran.');
      return;
    }
    patch(id, { status: 'running', note: undefined });
    try {
      await runOne(id);
    } catch (err) {
      failDb(id, errorText(err));
    }
  };

  const handle = async (evt: ActionEvent): Promise<void> => {
    const state = get();
    if (state.aiRequestId !== evt.requestId) return; // a stream nobody follows any more
    const norm = normalizeAction(evt.name, evt.args);
    if (!norm.ok) {
      failedCard(evt, fallbackAction(evt.name, evt.args), norm.error);
      return;
    }
    const action = norm.action;
    const base = {
      id: freshId(),
      requestId: evt.requestId,
      callId: evt.callId,
      name: action.name,
      action,
    } as const;
    if (!sameConnection()) {
      failedCard(evt, action, 'The connection changed since this chat started. Nothing ran.');
      return;
    }
    // Without schema sharing a failure note must not teach the model any names.
    const schemaOk = isAiSchemaAllowed(state.activeConfig?.id, state.settings);

    if (action.name === 'show_table') {
      const exists = (s: SessionState) =>
        s.schema?.tables.some((t) => t.schema === action.schema && t.name === action.table);
      if (!exists(state)) {
        const near = !schemaOk
          ? []
          : closeColumnNames(
              action.table,
              (state.schema?.tables ?? [])
                .filter((t) => t.schema === action.schema)
                .map((t) => t.name),
            );
        failedCard(
          evt,
          action,
          `Table ${action.schema}.${action.table} does not exist.${
            near.length > 0 ? ` Close names: ${near.join(', ')}.` : ''
          }`,
        );
        return;
      }
      await state.ensureSchemaColumns(action.schema);
      if (get().aiRequestId !== evt.requestId) return;
      const cols = (get().schema?.columns ?? [])
        .filter((c) => c.schema === action.schema && c.table === action.table)
        .sort((x, y) => x.ordinal - y.ordinal)
        .map((c) => ({ name: c.name, dataType: c.dataType }));
      if (cols.length === 0) {
        failedCard(evt, action, `Could not load the columns of ${action.schema}.${action.table}.`);
        return;
      }
      const checked = validateTableView(action.rawView, cols, { listNames: schemaOk });
      if (!checked.ok) {
        failedCard(evt, action, checked.error);
        return;
      }
      let view = checked.view;
      if (view.filters) {
        // The model never saw filter values it was not allowed to: a placeholder means "keep that one".
        const open = get().tabs.find(
          (t) =>
            t.kind === 'table' && t.tableSchema === action.schema && t.tableName === action.table,
        );
        const merged = mergeHiddenFilterValues(view.filters, open?.filters ?? []);
        if (!merged.ok) {
          failedCard(evt, action, merged.error);
          return;
        }
        view = { ...view, filters: merged.filters };
      }
      addCard({ ...base, status: 'pending', view, viewColumns: cols });
      if (get().settings.aiAutoApplyViews === true) await approve(base.id);
      return;
    }

    if (action.name === 'run_query' || action.name === 'propose_change') {
      if (safeRunPending(state.safeRun)) {
        failedCard(evt, action, SAFE_RUN_BLOCKED_NOTE);
        return;
      }
    }
    if (action.name === 'propose_change') {
      if (state.activeConfig?.readOnly === true) {
        failedCard(evt, action, 'The connection is read-only. Nothing ran.');
        return;
      }
      const preview = state.activeConfig?.engine === 'postgres' && isSafeRunnable(action.sql);
      addCard({ ...base, status: 'pending', mode: preview ? 'preview' : 'run' });
      return;
    }
    addCard({
      ...base,
      status: 'pending',
      ...(action.name === 'run_query'
        ? { sandboxed: agentReadSandboxed(state.activeConfig?.engine) }
        : {}),
    });
  };

  return {
    approve,
    async handleActionEvent(evt) {
      // A throw here would leave main waiting on a card that never appears.
      try {
        await handle(evt);
      } catch (err) {
        failedCard(
          evt,
          fallbackAction(evt.name, evt.args),
          `The app could not show this action: ${errorText(err).slice(0, 200)}`,
        );
      }
    },

    reject(id, note) {
      const a = get().aiActions[id];
      if (!a || a.status !== 'pending') return;
      const why = note?.trim() ? note.trim().slice(0, 300) : undefined;
      settle(id, 'rejected', why);
    },

    async undo(id) {
      const a = get().aiActions[id];
      if (!a || a.status !== 'applied' || !a.snapshot || !a.tabId || a.undone) return;
      patch(id, { undone: true });
      try {
        await restoreTableView(a.tabId, a.snapshot);
      } catch {
        /* the tab is gone: nothing to restore */
      }
    },

    cancelAll(reason, opts) {
      const UNKNOWN = 'Stopped; the statement may have run. Check the data.';
      for (const a of Object.values(get().aiActions)) {
        if (!isOpen(a)) continue;
        const send = opts?.send;
        const st = get();
        const tab = a.tabId ? st.tabs.find((t) => t.id === a.tabId) : undefined;
        const gate = a.tabId !== undefined && st.prodGate?.tabId === a.tabId;

        if (a.name === 'propose_change' && a.status === 'running') {
          if (a.mode === 'preview') {
            const sr = st.safeRun;
            const mine = sr && sr.tabId === a.tabId && sr.token !== a.safeRunPrev;
            // The commit is already on its way and cannot be recalled: the tracker reports what happened.
            if (mine && sr.phase === 'finishing') continue;
            if (gate) {
              st.cancelProdGate();
              settle(a.id, 'cancelled', 'Stopped before anything ran.', undefined, {}, { send });
            } else if (mine && safeRunPending(sr)) {
              settle(
                a.id,
                'cancelled',
                'Stopped; the preview was rolled back. Nothing changed.',
                undefined,
                {},
                { send },
              );
              void get().rollbackSafeRun('user');
            } else {
              settle(a.id, 'cancelled', reason, undefined, {}, { send });
            }
            continue;
          }
          // Plain run: before the prod confirmation / before it started we know; after, we do not.
          if (gate) {
            st.cancelProdGate();
            settle(a.id, 'cancelled', 'Stopped before the statement ran.', undefined, {}, { send });
          } else if (tab && (tab.queryGeneration ?? 0) <= (a.startGen ?? 0)) {
            settle(a.id, 'cancelled', 'Stopped before the statement ran.', undefined, {}, { send });
          } else {
            void ipc.query.cancel().catch(() => undefined);
            settle(a.id, 'cancelled', UNKNOWN, undefined, {}, { send });
          }
          continue;
        }

        // Reads, views and editor tabs change nothing: stopping them is exactly "cancelled".
        if (a.name === 'run_query' && a.status === 'running') {
          if (gate) st.cancelProdGate();
          else if (!a.sandboxed && tab?.queryRunState === 'running') {
            void ipc.query.cancel().catch(() => undefined);
          }
        }
        settle(a.id, 'cancelled', reason, undefined, {}, { send });
      }
    },
  };
}

export type { ActionEvent };
