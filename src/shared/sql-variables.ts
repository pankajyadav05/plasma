/**
 * Query variables: `:name`, `:'name'` and `$name` placeholders in SQL.
 *
 * `findVariableOccurrences` is a tokenizer-aware scan, so a placeholder is
 * only recognised in code position — never inside a string literal, a
 * quoted identifier, a comment or a dollar-quoted body, and never as a
 * `::cast` or the tail of an identifier (`a:b`, `arr[lo:hi]`).
 *
 * `bindVariables` turns the typed values into real bind parameters
 * (`$1…`) wherever the statement allows it. Only "raw SQL" variables are
 * substituted into the text (identifiers, expressions); `inline` forces
 * literal substitution for variables whose parameter type Postgres could
 * not infer (see `isUninferableParamError`).
 *
 * Pure and Electron-free: shared by the renderer, the notebook and tests.
 */

export type VariableSyntax = 'colon' | 'quoted' | 'dollar';

export interface VariableOccurrence {
  name: string;
  syntax: VariableSyntax;
  /** Offsets of the whole token (`:name`, `:'name'`, `$name`) in the SQL text. */
  start: number;
  end: number;
}

const IDENT_CHAR = /[A-Za-z0-9_$\u0080-￿]/;
const IDENT_START = /[A-Za-z_\u0080-￿]/;
const VAR_NAME = /[A-Za-z_][A-Za-z0-9_]*/y;
const DOLLAR_TAG = /\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/y;

/** Every placeholder in code position, in source order (repeats included). */
export function findVariableOccurrences(sql: string): VariableOccurrence[] {
  return scan(sql).vars;
}

/** True when the SQL already uses positional parameters (`$1`) in code position. */
export function hasPositionalParams(sql: string): boolean {
  return scan(sql).positional;
}

function scan(sql: string): { vars: VariableOccurrence[]; positional: boolean } {
  const out: VariableOccurrence[] = [];
  let positional = false;
  const N = sql.length;
  let i = 0;
  while (i < N) {
    const c = sql[i]!;

    // Line comment.
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i + 2);
      i = nl === -1 ? N : nl + 1;
      continue;
    }
    // Block comment (nesting allowed).
    if (c === '/' && sql[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < N && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }

    // String literal, optionally E-prefixed.
    const escapePrefix =
      (c === 'E' || c === 'e') && sql[i + 1] === "'" && (i === 0 || !IDENT_CHAR.test(sql[i - 1]!));
    if (c === "'" || escapePrefix) {
      if (escapePrefix) i++;
      i++;
      while (i < N) {
        if (escapePrefix && sql[i] === '\\') {
          i += i + 1 < N ? 2 : 1;
        } else if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
        } else if (sql[i] === "'") {
          i++;
          break;
        } else {
          i++;
        }
      }
      continue;
    }

    // Quoted identifier.
    if (c === '"') {
      i++;
      while (i < N) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          i += 2;
        } else if (sql[i] === '"') {
          i++;
          break;
        } else {
          i++;
        }
      }
      continue;
    }

    // `$`: dollar quote, positional `$1`, or a `$name` variable.
    if (c === '$') {
      DOLLAR_TAG.lastIndex = i;
      const tag = DOLLAR_TAG.exec(sql);
      if (tag) {
        const closer = tag[0];
        const end = sql.indexOf(closer, i + closer.length);
        i = end === -1 ? N : end + closer.length;
        continue;
      }
      const next = sql[i + 1];
      if (next !== undefined && /[0-9]/.test(next)) {
        positional = true;
        i++;
        while (i < N && /[0-9]/.test(sql[i]!)) i++;
        continue;
      }
      VAR_NAME.lastIndex = i + 1;
      const m = VAR_NAME.exec(sql);
      if (m) {
        const end = i + 1 + m[0].length;
        // `$name$` was handled as a dollar quote above; `$name` followed by
        // an identifier char is not a placeholder (cannot happen: VAR_NAME is greedy).
        out.push({ name: m[0], syntax: 'dollar', start: i, end });
        i = end;
        continue;
      }
      i++;
      continue;
    }

    // `:` — cast (`::`), `:name`, `:'name'`.
    if (c === ':') {
      if (sql[i + 1] === ':') {
        i += 2;
        while (sql[i] === ':') i++;
        continue;
      }
      const prev = i > 0 ? sql[i - 1]! : '';
      if (prev !== '' && IDENT_CHAR.test(prev)) {
        i++;
        continue;
      }
      if (sql[i + 1] === "'") {
        VAR_NAME.lastIndex = i + 2;
        const m = VAR_NAME.exec(sql);
        if (m && sql[i + 2 + m[0].length] === "'") {
          const end = i + 3 + m[0].length;
          out.push({ name: m[0], syntax: 'quoted', start: i, end });
          i = end;
          continue;
        }
        // Not a placeholder: let the string branch consume the quote.
        i++;
        continue;
      }
      VAR_NAME.lastIndex = i + 1;
      const m = VAR_NAME.exec(sql);
      if (m) {
        const end = i + 1 + m[0].length;
        out.push({ name: m[0], syntax: 'colon', start: i, end });
        i = end;
        continue;
      }
      i++;
      continue;
    }

    // Identifier / keyword: consume whole so `a$b` or `col:x` tails are never scanned.
    if (IDENT_START.test(c)) {
      i++;
      while (i < N && IDENT_CHAR.test(sql[i]!)) i++;
      continue;
    }

    i++;
  }
  return { vars: out, positional };
}

/** Distinct variable names in first-use order. */
export function listVariables(sql: string): string[] {
  const seen = new Set<string>();
  for (const o of findVariableOccurrences(sql)) seen.add(o.name);
  return [...seen];
}

// ─── Typed values ────────────────────────────────────────────────────

export type VariableMode = 'text' | 'number' | 'date' | 'boolean' | 'null' | 'raw';

export const VARIABLE_MODES: readonly VariableMode[] = [
  'text',
  'number',
  'date',
  'boolean',
  'null',
  'raw',
];

export interface VariableValue {
  mode: VariableMode;
  /** Text as typed. Ignored for `null`; `true`/`false` for booleans. */
  value: string;
}

export type VariableValues = Record<string, VariableValue>;

const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const DATE_RE =
  /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/;

/** Validation message for one value, or null when it can be bound. */
export function validateVariableValue(v: VariableValue): string | null {
  switch (v.mode) {
    case 'null':
      return null;
    case 'text':
      return null;
    case 'number':
      return NUMBER_RE.test(v.value.trim()) ? null : 'Enter a number';
    case 'date':
      return DATE_RE.test(v.value.trim()) ? null : 'Use YYYY-MM-DD or YYYY-MM-DD HH:MM:SS';
    case 'boolean':
      return /^(true|false)$/i.test(v.value.trim()) ? null : 'Choose true or false';
    case 'raw':
      return v.value.trim().length > 0 ? null : 'Enter SQL (an identifier or expression)';
  }
}

/** The bind-parameter value for a non-raw variable (node-pg sends it as text). */
export function toParam(v: VariableValue): string | null {
  switch (v.mode) {
    case 'null':
      return null;
    case 'number':
      return v.value.trim();
    case 'date':
      return v.value.trim();
    case 'boolean':
      return v.value.trim().toLowerCase();
    default:
      return v.value;
  }
}

/** A safe SQL literal for a non-raw variable (used when a param type is not inferable). */
export function toSqlLiteral(v: VariableValue): string {
  switch (v.mode) {
    case 'null':
      return 'NULL';
    case 'number':
      return v.value.trim();
    case 'boolean':
      return v.value.trim().toLowerCase();
    default: {
      const text = v.value;
      const quoted = text.replace(/'/g, "''");
      // Backslashes are only special in E'' strings; double them there so the
      // literal means the same under standard_conforming_strings on or off.
      return text.includes('\\') ? `E'${quoted.replace(/\\/g, '\\\\')}'` : `'${quoted}'`;
    }
  }
}

export interface BindResult {
  sql: string;
  params: unknown[];
  /** Names substituted into the SQL text verbatim (raw mode). */
  rawNames: string[];
  /** Variables in the SQL with no value supplied. */
  missing: string[];
  /** Variables whose value failed validation: name → message. */
  invalid: Record<string, string>;
  /** `paramNames[n - 1]` is the variable bound as `$n`. */
  paramNames: string[];
  /** Set when the statement mixes variables with its own `$1` parameters. */
  conflict: string | null;
}

export interface BindOptions {
  /** Names to substitute as literals instead of binding (see `isUninferableParamError`). */
  inline?: ReadonlySet<string>;
}

/**
 * Replace every placeholder in `sql`. Same name → same `$n`. When
 * anything is `missing` or `invalid` the returned SQL is the input
 * unchanged and must not be run.
 */
export function bindVariables(
  sql: string,
  values: VariableValues,
  opts: BindOptions = {},
): BindResult {
  const occurrences = findVariableOccurrences(sql);
  const result: BindResult = {
    sql,
    params: [],
    rawNames: [],
    missing: [],
    invalid: {},
    paramNames: [],
    conflict: null,
  };
  if (occurrences.length === 0) return result;

  for (const name of new Set(occurrences.map((o) => o.name))) {
    const v = values[name];
    if (!v) {
      result.missing.push(name);
      continue;
    }
    const problem = validateVariableValue(v);
    if (problem) result.invalid[name] = problem;
  }
  if (hasPositionalParams(sql)) {
    result.conflict =
      'This statement uses $1-style parameters; variables cannot be mixed with them.';
    return result;
  }
  if (result.missing.length > 0 || Object.keys(result.invalid).length > 0) return result;

  let next = 1;
  const indexOf = new Map<string, number>();
  const raw = new Set<string>();
  let out = '';
  let cursor = 0;
  for (const o of occurrences) {
    const v = values[o.name]!;
    out += sql.slice(cursor, o.start);
    cursor = o.end;
    if (v.mode === 'raw') {
      out += v.value.trim();
      raw.add(o.name);
    } else if (opts.inline?.has(o.name)) {
      out += toSqlLiteral(v);
    } else {
      let idx = indexOf.get(o.name);
      if (idx === undefined) {
        idx = next++;
        indexOf.set(o.name, idx);
        result.params.push(toParam(v));
        result.paramNames.push(o.name);
      }
      out += `$${idx}`;
    }
  }
  out += sql.slice(cursor);
  result.sql = out;
  result.rawNames = [...raw];
  return result;
}

/**
 * Postgres cannot always infer a parameter's type (`SELECT $1`). The
 * error names the parameter; the caller retries with that variable
 * inlined as a literal.
 */
export function isUninferableParamError(message: string): boolean {
  return /could not determine data type of parameter \$\d+/i.test(message);
}

/** The variable bound as the `$n` the error names, or null. */
export function uninferableParamName(message: string, bound: BindResult): string | null {
  const m = /could not determine data type of parameter \$(\d+)/i.exec(message);
  if (!m) return null;
  return bound.paramNames[Number(m[1]) - 1] ?? null;
}

/** What a statement needs before it can run; null when it can. */
export function variableProblem(sql: string, values: VariableValues): string | null {
  const bound = bindVariables(sql, values);
  if (bound.conflict) return bound.conflict;
  const invalid = Object.entries(bound.invalid)[0];
  if (invalid) return `:${invalid[0]} — ${invalid[1]}`;
  if (bound.missing.length > 0) {
    return `Fill in ${bound.missing.map((n) => `:${n}`).join(', ')} first`;
  }
  return null;
}

const MAX_RETRIES = 4;

/**
 * Bind `text` and hand `(sql, params)` to `exec`. A statement without
 * variables runs as written (`params` undefined). When the server cannot
 * infer a parameter's type the named variable is inlined as a quoted
 * literal and the statement is retried.
 */
export function runBound<T>(
  text: string,
  values: VariableValues,
  exec: (sql: string, params: unknown[] | undefined) => Promise<T>,
): Promise<T> {
  // Not `async`: a statement without variables must cost no extra microtask turns.
  if (findVariableOccurrences(text).length === 0) return exec(text, undefined);
  return runBoundWithVariables(text, values, exec);
}

async function runBoundWithVariables<T>(
  text: string,
  values: VariableValues,
  exec: (sql: string, params: unknown[] | undefined) => Promise<T>,
): Promise<T> {
  const inline = new Set<string>();
  for (let attempt = 0; ; attempt++) {
    const bound: BindResult = bindVariables(text, values, { inline });
    const problem = bound.conflict ?? variableProblem(text, values);
    if (problem) throw new Error(problem);
    try {
      return await exec(bound.sql, bound.params.length > 0 ? bound.params : undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const name = isUninferableParamError(message) ? uninferableParamName(message, bound) : null;
      if (!name || inline.has(name) || attempt >= MAX_RETRIES) throw err;
      inline.add(name);
    }
  }
}
