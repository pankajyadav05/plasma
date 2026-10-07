/**
 * The agent's actions (AI panel). The model proposes one with a tool call;
 * everything about it is validated here, in one place, for both main (which
 * refuses bad calls without ever asking the user) and the renderer (which
 * shows the card). Pure: nothing here touches a connection or the UI.
 */
import { z } from 'zod';
import { checkMemoryText } from './ai-memory';
import { isAgentReadSql } from './ai-readonly-sql';
import { AgentActionName } from './protocol';
import { splitSqlStatements } from './sql-statements';

export { AgentActionName };

const MAX_SQL_CHARS = 20_000;

const sqlText = z
  .string()
  .transform((s) => s.trim())
  .pipe(
    z
      .string()
      .min(1, 'sql is empty')
      .max(MAX_SQL_CHARS, `sql is longer than ${MAX_SQL_CHARS} characters`),
  );

const ident = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1).max(200));

const ShowTableArgs = z.object({
  schema: ident,
  table: ident,
  columns: z.unknown().optional(),
  sort: z.unknown().optional(),
  filters: z.unknown().optional(),
  limit: z.unknown().optional(),
});
const RunQueryArgs = z.object({
  sql: sqlText,
  title: z
    .string()
    .max(200)
    .optional()
    .transform((t) => t?.trim() || undefined),
});
const ProposeChangeArgs = z.object({
  sql: sqlText,
  summary: z
    .string()
    .max(1000)
    .optional()
    .transform((t) => t?.trim() ?? ''),
});
const OpenInEditorArgs = z.object({ sql: sqlText });
const RememberArgs = z.object({ text: z.string().max(5000) });
const ForgetArgs = z.object({
  id: ident,
  /** Not from the model: main fills in the note's text so the card can show it. */
  text: z.string().max(1000).optional(),
});

/** A tool call that passed `normalizeAction`. */
export type AgentActionInput =
  | {
      name: 'show_table';
      schema: string;
      table: string;
      /** columns / sort / filters / limit exactly as the model sent them; `validateTableView` checks them against the real columns. */
      rawView: Record<string, unknown>;
    }
  | { name: 'run_query'; sql: string; title?: string }
  | { name: 'propose_change'; sql: string; summary: string }
  | { name: 'open_in_editor'; sql: string }
  | { name: 'remember'; text: string }
  | { name: 'forget'; id: string; text?: string };

export type NormalizedAction =
  | { ok: true; action: AgentActionInput }
  | { ok: false; error: string };

function firstIssue(err: z.ZodError): string {
  const i = err.issues[0];
  if (!i) return 'invalid arguments';
  const path = i.path.join('.');
  if (i.code === 'invalid_type' && i.received === 'undefined') {
    return `${path || 'argument'} is required`;
  }
  return path ? `${path}: ${i.message}` : i.message;
}

/** Exactly one statement, or the reason it is not. */
function singleStatement(sql: string): string | null {
  const n = splitSqlStatements(sql).length;
  if (n === 1) return null;
  return n === 0
    ? 'sql is empty'
    : `send exactly one statement per call (found ${n}); make one call per statement`;
}

/** Validate a model tool call. The error text goes back to the model as the tool result. */
export function normalizeAction(name: string, args: unknown): NormalizedAction {
  const parsedName = AgentActionName.safeParse(name);
  if (!parsedName.success) return { ok: false, error: `unknown action ${name}` };
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  switch (parsedName.data) {
    case 'show_table': {
      const r = ShowTableArgs.safeParse(a);
      if (!r.success) return { ok: false, error: firstIssue(r.error) };
      const { schema, table, ...view } = r.data;
      const rawView: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(view)) if (v !== undefined) rawView[k] = v;
      return { ok: true, action: { name: 'show_table', schema, table, rawView } };
    }
    case 'run_query': {
      const r = RunQueryArgs.safeParse(a);
      if (!r.success) return { ok: false, error: firstIssue(r.error) };
      const multi = singleStatement(r.data.sql);
      if (multi) return { ok: false, error: multi };
      if (!isAgentReadSql(r.data.sql)) {
        return {
          ok: false,
          error:
            'run_query is for read-only queries (SELECT, WITH, EXPLAIN, SHOW, VALUES, TABLE) that change nothing. Use propose_change for a statement that changes data or schema.',
        };
      }
      return { ok: true, action: { name: 'run_query', sql: r.data.sql, title: r.data.title } };
    }
    case 'propose_change': {
      const r = ProposeChangeArgs.safeParse(a);
      if (!r.success) return { ok: false, error: firstIssue(r.error) };
      const multi = singleStatement(r.data.sql);
      if (multi) return { ok: false, error: multi };
      if (isAgentReadSql(r.data.sql)) {
        return {
          ok: false,
          error:
            'This statement only reads data. Use run_query to run it, or open_in_editor to put it in an editor.',
        };
      }
      return {
        ok: true,
        action: { name: 'propose_change', sql: r.data.sql, summary: r.data.summary },
      };
    }
    case 'open_in_editor': {
      const r = OpenInEditorArgs.safeParse(a);
      if (!r.success) return { ok: false, error: firstIssue(r.error) };
      return { ok: true, action: { name: 'open_in_editor', sql: r.data.sql } };
    }
    case 'remember': {
      const r = RememberArgs.safeParse(a);
      if (!r.success) return { ok: false, error: firstIssue(r.error) };
      // Duplicates and the note cap need the stored notes: main checks those next.
      const checked = checkMemoryText(r.data.text, []);
      if (!checked.ok) return { ok: false, error: checked.error };
      return { ok: true, action: { name: 'remember', text: checked.text } };
    }
    case 'forget': {
      const r = ForgetArgs.safeParse(a);
      if (!r.success) return { ok: false, error: firstIssue(r.error) };
      return { ok: true, action: { name: 'forget', id: r.data.id, text: r.data.text } };
    }
  }
}

/** Card title per action. */
export function actionTitle(name: AgentActionName): string {
  switch (name) {
    case 'show_table':
      return 'Show table';
    case 'run_query':
      return 'Run query';
    case 'propose_change':
      return 'Change data';
    case 'open_in_editor':
      return 'Open in editor';
    case 'remember':
      return 'Remember';
    case 'forget':
      return 'Forget';
  }
}

/** One-line subject of an action: the table, or the SQL's first line. */
export function actionSubject(action: AgentActionInput): string {
  if (action.name === 'show_table') return `${action.schema}.${action.table}`;
  if (action.name === 'remember') return clip(action.text);
  if (action.name === 'forget') return clip(action.text ?? action.id);
  const first = action.sql.split('\n').find((l) => l.trim().length > 0) ?? '';
  return clip(first.trim());
}

function clip(line: string): string {
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

export type AgentActionStatus =
  | 'pending'
  | 'running'
  | 'applied'
  | 'rejected'
  | 'failed'
  | 'cancelled';

/**
 * The line standing in for an action when a turn is sent back to the model
 * as history: `[show_table public.orders: applied]`,
 * `[propose_change: rejected — "only paid orders"]`.
 */
export function actionHistoryLine(
  action: AgentActionInput,
  status: AgentActionStatus,
  note?: string,
): string {
  const subject = action.name === 'show_table' ? ` ${actionSubject(action)}` : '';
  const state = status === 'pending' || status === 'running' ? 'not answered' : status;
  const why = note?.trim() ? ` — "${note.trim().slice(0, 200)}"` : '';
  return `[${action.name}${subject}: ${state}${why}]`;
}
