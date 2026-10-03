import type { ExplainNode } from '@shared/protocol';

/**
 * Convert SQLite / MySQL plans to the Postgres `FORMAT JSON` shape the plan
 * viewer renders (`[{ Plan: { 'Node Type', Plans: [...] } }]`), so the one
 * explain dialog serves every SQL engine.
 */

export interface SqlitePlanRow {
  id: number;
  parent: number;
  detail: string;
}

/** `EXPLAIN QUERY PLAN` rows (id / parent / detail) → a plan tree. */
export function sqlitePlanToJson(rows: readonly SqlitePlanRow[]): unknown {
  const nodes = new Map<number, ExplainNode>();
  const root: ExplainNode = { 'Node Type': 'Query plan', Plans: [] };
  for (const r of rows) {
    const rel = /^(?:SCAN|SEARCH)\s+(?:TABLE\s+)?("[^"]+"|\S+)/i.exec(r.detail)?.[1];
    const idx = /USING (?:COVERING )?INDEX\s+(\S+)/i.exec(r.detail)?.[1];
    const node: ExplainNode = { 'Node Type': r.detail };
    if (rel) node['Relation Name'] = rel.replace(/^"|"$/g, '');
    if (idx) node['Index Name'] = idx;
    nodes.set(r.id, node);
    const parent = r.parent === 0 ? root : (nodes.get(r.parent) ?? root);
    parent.Plans = [...(parent.Plans ?? []), node];
  }
  return [{ Plan: root }];
}

/**
 * ClickHouse `EXPLAIN` text (one node per line, children indented by two
 * spaces) → a plan tree. `ReadFromMergeTree (db.table)` becomes a node with
 * its relation, so the viewer can show what is scanned.
 */
export function clickhousePlanToJson(lines: readonly string[]): unknown {
  const root: ExplainNode = { 'Node Type': 'Query plan', Plans: [] };
  const stack: Array<{ depth: number; node: ExplainNode }> = [{ depth: -1, node: root }];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const depth = Math.floor((raw.length - raw.trimStart().length) / 2);
    const text = raw.trim();
    const node: ExplainNode = { 'Node Type': text };
    const scan = /^ReadFrom\w+\s*\(([^)]+)\)/.exec(text);
    if (scan) node['Relation Name'] = (scan[1] as string).trim();
    while (stack.length > 1 && (stack[stack.length - 1] as { depth: number }).depth >= depth) {
      stack.pop();
    }
    const parent = (stack[stack.length - 1] as { node: ExplainNode }).node;
    parent.Plans = [...(parent.Plans ?? []), node];
    stack.push({ depth, node });
  }
  return [{ Plan: root }];
}

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

const OPERATION_KEYS = [
  'ordering_operation',
  'grouping_operation',
  'duplicates_removal',
  'buffer_result',
  'windowing',
  'nested_loop',
  'union_result',
  'materialized_from_subquery',
  'attached_subqueries',
  'optimized_away_subqueries',
  'query_specifications',
  'query_block',
  'table',
];

function label(key: string): string {
  return key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function tableNode(t: Json): ExplainNode {
  const access = typeof t.access_type === 'string' ? t.access_type : 'ALL';
  const name = String(t.table_name ?? '');
  const node: ExplainNode = {
    'Node Type': access.toUpperCase() === 'ALL' ? 'Full scan' : `${access} scan`,
  };
  if (name) node['Relation Name'] = name;
  if (typeof t.key === 'string') node['Index Name'] = t.key;
  const rows = num(t.rows_examined_per_scan) ?? num(t.rows);
  if (rows !== undefined) node['Plan Rows'] = rows;
  const cost = isObj(t.cost_info) ? num(t.cost_info.prefix_cost) : undefined;
  if (cost !== undefined) node['Total Cost'] = cost;
  if (typeof t.attached_condition === 'string') node.Filter = t.attached_condition;
  const sub = collect(t);
  if (sub.length > 0) node.Plans = sub;
  return node;
}

function collect(obj: Json): ExplainNode[] {
  const out: ExplainNode[] = [];
  for (const key of OPERATION_KEYS) {
    const v = obj[key];
    if (v === undefined) continue;
    const values = Array.isArray(v) ? v : [v];
    for (const item of values) {
      if (!isObj(item)) continue;
      if (key === 'table') {
        out.push(tableNode(item));
      } else if (key === 'nested_loop' && isObj(item.table) && Object.keys(item).length === 1) {
        // nested_loop entries are `{ table: {...} }`.
        out.push(tableNode(item.table));
      } else {
        const node: ExplainNode = { 'Node Type': label(key) };
        const inner = collect(item);
        if (inner.length > 0) node.Plans = inner;
        out.push(node);
      }
    }
  }
  return out;
}

/** `EXPLAIN FORMAT=JSON` output (MySQL and MariaDB) → a plan tree. */
export function mysqlPlanToJson(raw: unknown): unknown {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const block = isObj(parsed) && isObj(parsed.query_block) ? parsed.query_block : null;
  if (!block) throw new Error('unexpected EXPLAIN payload');
  const root: ExplainNode = { 'Node Type': 'Query block' };
  const cost = isObj(block.cost_info) ? num(block.cost_info.query_cost) : undefined;
  if (cost !== undefined) root['Total Cost'] = cost;
  const plans = collect(block);
  if (plans.length > 0) root.Plans = plans;
  return [{ Plan: root }];
}
