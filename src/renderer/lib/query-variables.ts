/**
 * Query variables in the run pipeline: bind a statement's `:name` /
 * `$name` placeholders from the tab's typed values, run it, and retry once
 * per variable whose parameter type Postgres could not infer.
 *
 * Shared by Run (selected / current / all), Explain and Safe Run so they
 * all honour the same values. The parsing and binding itself lives in
 * `@shared/sql-variables`.
 */
import {
  type VariableValue,
  type VariableValues,
  bindVariables,
  findVariableOccurrences,
  listVariables,
} from '@shared/sql-variables';

export type { VariableValue, VariableValues };
export { listVariables, runBound, variableProblem } from '@shared/sql-variables';

/** Variable names (in `sql`) that are missing or invalid. */
export function unresolvedVariables(sql: string, values: VariableValues): string[] {
  const bound = bindVariables(sql, values);
  return [...bound.missing, ...Object.keys(bound.invalid)];
}

/**
 * The statement with every value written inline as a literal (raw mode as
 * typed). For preview, for the prod-gate confirmation and for write
 * detection — never for execution of text values: execution binds them.
 */
export function inlineVariables(sql: string, values: VariableValues): string {
  const names = new Set(listVariables(sql));
  const bound = bindVariables(sql, values, { inline: names });
  return bound.missing.length > 0 || bound.conflict || Object.keys(bound.invalid).length > 0
    ? sql
    : bound.sql;
}

/** Variables substituted verbatim (raw SQL) in this statement. */
export function rawVariablesIn(sql: string, values: VariableValues): string[] {
  const names = new Set(findVariableOccurrences(sql).map((o) => o.name));
  return [...names].filter((n) => values[n]?.mode === 'raw');
}

/** Newest-first history with duplicates removed, capped. */
export function pushVariableHistory(
  history: Record<string, string[]>,
  name: string,
  value: VariableValue,
  max = 8,
): Record<string, string[]> {
  if (value.mode === 'null' || value.value.trim() === '') return history;
  const prev = history[name] ?? [];
  const next = [value.value, ...prev.filter((v) => v !== value.value)].slice(0, max);
  if (next.length === prev.length && next.every((v, i) => v === prev[i])) return history;
  return { ...history, [name]: next };
}

/** History after a run that used `names` with `values`; the same object when nothing changed. */
export function mergeVariableHistory(
  history: Record<string, string[]>,
  names: readonly string[],
  values: VariableValues,
): Record<string, string[]> {
  let out = history;
  for (const name of names) {
    const v = values[name];
    if (v) out = pushVariableHistory(out, name, v);
  }
  return out;
}

/** A blank value for a new variable. */
export function defaultVariableValue(): VariableValue {
  return { mode: 'text', value: '' };
}

/**
 * Keep entries for the names in use; add blanks only for names that have a
 * saved value, so an untouched variable stays "missing".
 */
export function pruneVariableValues(
  values: VariableValues,
  names: readonly string[],
): VariableValues {
  const keep = new Set(names);
  const out: VariableValues = {};
  for (const [k, v] of Object.entries(values)) if (keep.has(k)) out[k] = v;
  return out;
}
