/**
 * One-shot AI tasks (bring-your-own-key): "Fix with AI", "Explain this
 * plan" and the natural-language grid filter.
 *
 * Everything here is pure: prompt builders (what is sent), response
 * parsers (what comes back) and a schema reducer. The model's output is
 * only ever a SUGGESTION — parsers validate it and the UI shows it before
 * anything is applied; nothing here executes SQL.
 */
import type { SchemaInfo } from './protocol';
import { splitSqlStatementRanges } from './sql-split';

export type AiTask = 'fix-sql' | 'explain-plan' | 'nl-filter';

// ─── System prompts (main prepends the schema when policy allows) ────

const FIX_SQL_SYSTEM = `You are Plasma's SQL repair assistant for PostgreSQL. The user ran a statement and it failed. Return the corrected statement.

Rules:
- Change as little as possible; keep the user's intent, formatting and aliases.
- Use only tables and columns from the schema when one is given. If a name looks misspelled, correct it to the closest real one.
- Reply with one short explanation of what was wrong (1-2 sentences), then the FULL corrected statement in a single \`\`\`sql code block.
- The corrected statement must be a single statement. Never add DROP, TRUNCATE or other destructive statements that the original did not contain.
- If you cannot fix it with confidence, say why and still return your best attempt in the code block.`;

const EXPLAIN_PLAN_SYSTEM = `You are Plasma's PostgreSQL performance assistant. You are given a query and its EXPLAIN plan (summarised, one node per line, children indented).

Reply in this shape:
1. A plain-English walk-through of the plan, from the innermost steps outward, in short paragraphs or bullets. Name the slow or risky steps (sequential scans on big tables, bad row estimates, sorts spilling to disk, nested loops with many loops) and why they hurt.
2. Then, only when an index would clearly help, one \`\`\`sql code block PER index. Each block starts with a "-- reason" comment line and then exactly one statement of the form CREATE INDEX CONCURRENTLY [IF NOT EXISTS] name ON table (columns) [WHERE ...];
Rules: never suggest anything other than CREATE INDEX CONCURRENTLY; use real table and column names from the plan or schema; suggest at most 3 indexes; if no index would help say so and give no code block.`;

const NL_FILTER_SYSTEM = `You translate a natural-language request into filters for ONE database table, shown in a grid filter bar.

Reply with ONLY a JSON object, no prose, no code fence:
{"filters":[{"column":"<exact column name>","op":"<operator>","value":"<text>"}],"where":null,"explanation":"<one short sentence>"}

Rules:
- Allowed operators: =, !=, >, <, >=, <=, LIKE, ILIKE, NOT LIKE, NOT ILIKE, IN, NOT IN, BETWEEN, IS NULL, IS NOT NULL. Filters are ANDed together.
- "value" is always a string. LIKE/ILIKE values are wrapped in % by the app, so do not add them. IN takes "a, b, c". BETWEEN takes "low, high". Omit value (use "") for IS NULL / IS NOT NULL.
- Dates and timestamps are ISO text (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS). Resolve relative dates ("last week", "yesterday") against the "today" date you are given.
- Use only the listed columns, spelled exactly.
- If the request cannot be expressed with those filters (OR logic, expressions, functions, joins), set "filters" to [] and put a single SQL boolean expression in "where" (no WHERE keyword, no semicolon, no comments, only listed columns). Otherwise "where" is null.
- If the request cannot be understood, return {"filters":[],"where":null,"explanation":"<why>"}.`;

export function taskSystemPrompt(task: AiTask): string {
  switch (task) {
    case 'fix-sql':
      return FIX_SQL_SYSTEM;
    case 'explain-plan':
      return EXPLAIN_PLAN_SYSTEM;
    case 'nl-filter':
      return NL_FILTER_SYSTEM;
  }
}

/** Output budget per task so a runaway answer cannot burn the user's key. */
export function taskMaxTokens(task: AiTask): number {
  return task === 'explain-plan' ? 1800 : task === 'fix-sql' ? 1200 : 500;
}

// ─── Relevant schema ─────────────────────────────────────────────────

const MAX_RELEVANT_TABLES = 25;

/**
 * Narrow a schema to the tables a statement touches (plus one hop of
 * foreign-key neighbours), so only what is relevant leaves the machine.
 * When nothing in the text matches a table name the first tables are
 * returned instead (a typo'd table name is the usual reason), capped.
 */
export function relevantSchema(schema: SchemaInfo, text: string): SchemaInfo {
  const words = new Set((text.toLowerCase().match(/[a-z_][a-z0-9_$]*/g) ?? []).map((w) => w));
  const key = (s: string, t: string) => `${s}.${t}`;
  const hit = new Set<string>();
  for (const t of schema.tables) {
    if (words.has(t.name.toLowerCase())) hit.add(key(t.schema, t.name));
  }
  const direct = new Set(hit);
  for (const fk of schema.foreignKeys) {
    const from = key(fk.schema, fk.table);
    const to = key(fk.refSchema, fk.refTable);
    if (direct.has(from)) hit.add(to);
    else if (direct.has(to)) hit.add(from);
  }
  let tables = schema.tables.filter((t) => hit.has(key(t.schema, t.name)));
  if (tables.length === 0) tables = schema.tables.slice(0, MAX_RELEVANT_TABLES);
  tables = tables.slice(0, MAX_RELEVANT_TABLES);
  const keep = new Set(tables.map((t) => key(t.schema, t.name)));
  return {
    ...schema,
    tables,
    columns: schema.columns.filter((c) => keep.has(key(c.schema, c.table))),
    foreignKeys: schema.foreignKeys.filter(
      (f) => keep.has(key(f.schema, f.table)) && keep.has(key(f.refSchema, f.refTable)),
    ),
    indexes: schema.indexes?.filter((i) => keep.has(key(i.schema, i.table))),
  };
}

// ─── Fix with AI ─────────────────────────────────────────────────────

const MAX_SQL_CHARS = 12_000;

export function buildFixSqlPrompt(input: { sql: string; error: string }): string {
  const sql = clip(input.sql, MAX_SQL_CHARS);
  return `This statement failed.\n\nError:\n${clip(input.error.trim(), 2_000)}\n\nSQL:\n\`\`\`sql\n${sql}\n\`\`\``;
}

export interface FixSqlSuggestion {
  sql: string;
  explanation: string;
}

/** First ```sql block is the fix; prose around it is the explanation. Null when there is no usable SQL. */
export function parseFixSqlResponse(text: string): FixSqlSuggestion | null {
  const blocks = extractCodeBlocks(text);
  const block = blocks.find((b) => b.lang === 'sql') ?? blocks.find((b) => b.lang === '') ?? null;
  if (!block) return null;
  const sql = block.code.trim();
  if (!sql) return null;
  // A "fix" is exactly one statement: it replaces the statement that failed.
  if (splitSqlStatementRanges(sql).length !== 1) return null;
  return { sql: sql.replace(/;\s*$/, ''), explanation: stripCodeBlocks(text).trim() };
}

// ─── Explain this plan ───────────────────────────────────────────────

interface PlanLike {
  [key: string]: unknown;
  Plans?: PlanLike[];
}

const PLAN_DETAIL_KEYS = [
  'Index Cond',
  'Filter',
  'Rows Removed by Filter',
  'Hash Cond',
  'Join Filter',
  'Merge Cond',
  'Sort Key',
  'Sort Method',
  'Group Key',
  'Recheck Cond',
] as const;

/** Compact, token-cheap text for a `FORMAT JSON` plan node tree. */
export function summarizePlanForAi(root: unknown, maxChars = 14_000): string {
  const lines: string[] = [];
  const walk = (node: PlanLike, depth: number) => {
    const t = String(node['Node Type'] ?? '?');
    const parts = [`${'  '.repeat(depth)}- ${t}`];
    if (node['Relation Name']) {
      const schema = node.Schema ? `${String(node.Schema)}.` : '';
      parts.push(`on ${schema}${String(node['Relation Name'])}`);
    }
    if (node['Index Name']) parts.push(`using ${String(node['Index Name'])}`);
    const stats: string[] = [];
    if (typeof node['Total Cost'] === 'number')
      stats.push(`cost=${Math.round(node['Total Cost'])}`);
    if (typeof node['Plan Rows'] === 'number') stats.push(`rows=${node['Plan Rows']}`);
    if (typeof node['Actual Rows'] === 'number') {
      stats.push(`actual_rows=${node['Actual Rows']}`);
      if (typeof node['Actual Loops'] === 'number') stats.push(`loops=${node['Actual Loops']}`);
      if (typeof node['Actual Total Time'] === 'number') {
        stats.push(`time=${Number(node['Actual Total Time']).toFixed(2)}ms`);
      }
    }
    if (typeof node['Shared Read Blocks'] === 'number' && node['Shared Read Blocks'] > 0) {
      stats.push(`read_blocks=${node['Shared Read Blocks']}`);
    }
    if (stats.length > 0) parts.push(`(${stats.join(' ')})`);
    lines.push(parts.join(' '));
    for (const k of PLAN_DETAIL_KEYS) {
      const v = node[k];
      if (v === undefined || v === null) continue;
      lines.push(`${'  '.repeat(depth + 1)}${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`);
    }
    for (const child of node.Plans ?? []) walk(child, depth + 1);
  };
  const first = Array.isArray(root) ? root[0] : root;
  const top = (first as { Plan?: PlanLike } | undefined)?.Plan ?? (first as PlanLike | undefined);
  if (top && typeof top === 'object') walk(top, 0);
  const meta = first as Record<string, unknown> | undefined;
  if (typeof meta?.['Planning Time'] === 'number') {
    lines.push(`Planning time: ${Number(meta['Planning Time']).toFixed(2)} ms`);
  }
  if (typeof meta?.['Execution Time'] === 'number') {
    lines.push(`Execution time: ${Number(meta['Execution Time']).toFixed(2)} ms`);
  }
  return clip(lines.join('\n'), maxChars);
}

export function buildExplainPlanPrompt(input: {
  sql: string;
  plan: unknown;
  analyzed: boolean;
}): string {
  return `Query:\n\`\`\`sql\n${clip(input.sql, MAX_SQL_CHARS)}\n\`\`\`\n\nPlan (${
    input.analyzed ? 'EXPLAIN ANALYZE, real timings' : 'EXPLAIN only, estimates'
  }):\n${summarizePlanForAi(input.plan)}`;
}

export interface IndexSuggestion {
  /** One `CREATE INDEX CONCURRENTLY …` statement, no trailing semicolon. */
  sql: string;
  reason: string;
}

export interface PlanExplanation {
  explanation: string;
  indexes: IndexSuggestion[];
}

const CREATE_INDEX_RE = /^create\s+(unique\s+)?index\s+(concurrently\s+)?(if\s+not\s+exists\s+)?/i;

/**
 * Walk-through = the prose; indexes = each sql block that is exactly one
 * CREATE INDEX statement. A missing CONCURRENTLY is added; any other
 * statement is dropped, never surfaced as a suggestion.
 */
export function parseExplainPlanResponse(text: string): PlanExplanation {
  const indexes: IndexSuggestion[] = [];
  for (const block of extractCodeBlocks(text)) {
    if (block.lang !== 'sql' && block.lang !== '') continue;
    const reasonLines: string[] = [];
    const codeLines: string[] = [];
    for (const line of block.code.split('\n')) {
      const m = /^\s*--\s?(.*)$/.exec(line);
      if (m && codeLines.length === 0) reasonLines.push(m[1]!.trim());
      else codeLines.push(line);
    }
    const body = codeLines.join('\n').trim();
    if (!body) continue;
    const stmts = splitSqlStatementRanges(body);
    if (stmts.length !== 1) continue;
    const stmt = stmts[0]!.text.replace(/;\s*$/, '');
    const m = CREATE_INDEX_RE.exec(stmt);
    if (!m) continue;
    const sql = m[2]
      ? stmt
      : stmt.replace(
          CREATE_INDEX_RE,
          `CREATE ${m[1] ? 'UNIQUE ' : ''}INDEX CONCURRENTLY ${m[3] ?? ''}`,
        );
    if (!indexes.some((i) => i.sql === sql)) {
      indexes.push({ sql, reason: reasonLines.join(' ') });
    }
  }
  return { explanation: stripCodeBlocks(text).trim(), indexes: indexes.slice(0, 3) };
}

// ─── Natural-language grid filter ────────────────────────────────────

/** Mirror of `FilterOp` in the renderer's table-query module. */
export const NL_FILTER_OPS = [
  '=',
  '!=',
  '>',
  '<',
  '>=',
  '<=',
  'LIKE',
  'ILIKE',
  'NOT LIKE',
  'NOT ILIKE',
  'IN',
  'NOT IN',
  'BETWEEN',
  'IS NULL',
  'IS NOT NULL',
] as const;
export type NlFilterOp = (typeof NL_FILTER_OPS)[number];

export interface NlFilterColumn {
  name: string;
  dataType: string;
}

export function buildNlFilterPrompt(input: {
  request: string;
  schema: string;
  table: string;
  columns: NlFilterColumn[];
  /** ISO date the model resolves "last week" against. */
  today: string;
}): string {
  const cols = input.columns
    .slice(0, 80)
    .map((c) => `- ${c.name} (${c.dataType})`)
    .join('\n');
  return `Table: ${input.schema}.${input.table}\nToday: ${input.today}\nColumns:\n${cols}\n\nRequest: ${clip(input.request.trim(), 500)}`;
}

export interface NlFilterRow {
  column: string;
  op: NlFilterOp;
  value: string;
}

export type NlFilterSuggestion =
  | { kind: 'filters'; filters: NlFilterRow[]; explanation: string }
  | { kind: 'where'; where: string; explanation: string }
  | { kind: 'none'; explanation: string };

/** Words that must never appear in a suggested WHERE fragment. */
const WHERE_FORBIDDEN =
  /\b(select|insert|update|delete|drop|alter|truncate|create|grant|revoke|copy|call|execute|do|pg_sleep|pg_read_file|lo_import|set)\b/i;

/** True for a single boolean-expression fragment that is safe to show and to paste after WHERE. */
export function isSafeWhereFragment(where: string): boolean {
  const w = where.trim();
  if (!w || w.length > 1_000) return false;
  if (w.includes(';') || w.includes('--') || w.includes('/*')) return false;
  // Words inside string literals and quoted identifiers are fine.
  const bare = w.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
  if (bare.includes('$$')) return false;
  return !WHERE_FORBIDDEN.test(bare);
}

/**
 * Parse the model's JSON. `columns` are the real column names: a filter
 * naming anything else is dropped; if any filter is invalid the whole
 * suggestion falls back to the WHERE fragment (or none) rather than
 * applying a partial, misleading filter.
 */
export function parseNlFilterResponse(
  text: string,
  columns: readonly NlFilterColumn[],
): NlFilterSuggestion {
  const obj = extractJsonObject(text);
  if (!obj) return { kind: 'none', explanation: 'The assistant did not return a usable answer.' };
  const explanation = typeof obj.explanation === 'string' ? obj.explanation.trim() : '';
  const names = new Set(columns.map((c) => c.name));
  const rawFilters = Array.isArray(obj.filters) ? obj.filters : [];
  const filters: NlFilterRow[] = [];
  let allValid = rawFilters.length > 0;
  for (const f of rawFilters) {
    const row = f as Record<string, unknown>;
    const column = typeof row.column === 'string' ? row.column : '';
    const op = typeof row.op === 'string' ? row.op.trim().toUpperCase() : '';
    const rawValue = row.value;
    const value =
      typeof rawValue === 'string'
        ? rawValue
        : typeof rawValue === 'number'
          ? String(rawValue)
          : '';
    const nullary = op === 'IS NULL' || op === 'IS NOT NULL';
    if (
      !names.has(column) ||
      !(NL_FILTER_OPS as readonly string[]).includes(op) ||
      (!nullary && value.trim() === '')
    ) {
      allValid = false;
      break;
    }
    filters.push({ column, op: op as NlFilterOp, value: nullary ? '' : value });
  }
  if (allValid && filters.length > 0) return { kind: 'filters', filters, explanation };
  const where = typeof obj.where === 'string' ? obj.where.trim() : '';
  if (where && isSafeWhereFragment(where)) return { kind: 'where', where, explanation };
  return {
    kind: 'none',
    explanation: explanation || 'That request could not be turned into a filter.',
  };
}

// ─── Shared text helpers ─────────────────────────────────────────────

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n-- … truncated` : text;
}

interface CodeBlock {
  lang: string;
  code: string;
}

function extractCodeBlocks(text: string): CodeBlock[] {
  const out: CodeBlock[] = [];
  for (const m of text.matchAll(/```([A-Za-z0-9_+-]*)[^\n]*\n([\s\S]*?)```/g)) {
    out.push({ lang: (m[1] ?? '').toLowerCase(), code: m[2] ?? '' });
  }
  return out;
}

function stripCodeBlocks(text: string): string {
  return text.replace(/```[A-Za-z0-9_+-]*[^\n]*\n[\s\S]*?```/g, '').replace(/\n{3,}/g, '\n\n');
}

/** The first balanced `{ … }` in `text` that parses as a JSON object. */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(text);
  const candidates = fenced ? [fenced[1]!, text] : [text];
  for (const src of candidates) {
    for (let start = src.indexOf('{'); start !== -1; start = src.indexOf('{', start + 1)) {
      let depth = 0;
      let inStr = false;
      for (let i = start; i < src.length; i++) {
        const c = src[i]!;
        if (inStr) {
          if (c === '\\') i++;
          else if (c === '"') inStr = false;
        } else if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) {
          try {
            const parsed = JSON.parse(src.slice(start, i + 1));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
          } catch {
            /* try the next brace */
          }
          break;
        }
      }
    }
  }
  return null;
}
