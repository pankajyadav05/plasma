/**
 * SQL snippets for the editor: a built-in set, helpers for user snippets
 * and JSON import/export. Bodies use Monaco's snippet syntax
 * (`$1`, `${2:default}`, `${3|a,b|}`, `$0`); a literal `$`, `}` or `\`
 * is written `\$`, `\}` and `\\`.
 */

export interface SnippetDef {
  name: string;
  /** Typed in the editor to trigger the completion. */
  prefix: string;
  description: string;
  body: string;
}

export const BUILTIN_SNIPPETS: readonly SnippetDef[] = [
  {
    name: 'select where',
    prefix: 'selw',
    description: 'SELECT columns FROM table WHERE condition',
    body: 'SELECT ${3:*}\nFROM ${1:table}\nWHERE ${2:condition}\nLIMIT ${4:100};$0',
  },
  {
    name: 'select count group by',
    prefix: 'selg',
    description: 'Count rows per group, largest first',
    body: 'SELECT ${1:column}, count(*) AS n\nFROM ${2:table}\nGROUP BY ${1:column}\nORDER BY n DESC\nLIMIT ${3:50};$0',
  },
  {
    name: 'join',
    prefix: 'join',
    description: 'Two tables joined on a key',
    body: 'SELECT ${5:a.*, b.*}\nFROM ${1:table_a} a\nJOIN ${2:table_b} b ON b.${3:a_id} = a.${4:id}\nWHERE ${6:true}\nLIMIT ${7:100};$0',
  },
  {
    name: 'left join, rows without a match',
    prefix: 'antijoin',
    description: 'Rows in A with no matching row in B',
    body: 'SELECT a.*\nFROM ${1:table_a} a\nLEFT JOIN ${2:table_b} b ON b.${3:a_id} = a.${4:id}\nWHERE b.${3:a_id} IS NULL;$0',
  },
  {
    name: 'insert',
    prefix: 'ins',
    description: 'INSERT with RETURNING',
    body: 'INSERT INTO ${1:table} (${2:col1}, ${3:col2})\nVALUES (${4:v1}, ${5:v2})\nRETURNING *;$0',
  },
  {
    name: 'upsert (insert on conflict)',
    prefix: 'upsert',
    description: 'INSERT … ON CONFLICT DO UPDATE',
    body: 'INSERT INTO ${1:table} (${2:id}, ${3:col})\nVALUES (${4:1}, ${5:value})\nON CONFLICT (${2:id}) DO UPDATE\n  SET ${3:col} = EXCLUDED.${3:col}\nRETURNING *;$0',
  },
  {
    name: 'update where',
    prefix: 'updw',
    description: 'UPDATE with a WHERE clause and RETURNING',
    body: 'UPDATE ${1:table}\nSET ${2:col} = ${3:value}\nWHERE ${4:id = 1}\nRETURNING *;$0',
  },
  {
    name: 'delete where',
    prefix: 'delw',
    description: 'DELETE with a WHERE clause and RETURNING',
    body: 'DELETE FROM ${1:table}\nWHERE ${2:id = 1}\nRETURNING *;$0',
  },
  {
    name: 'CTE (with)',
    prefix: 'cte',
    description: 'Common table expression',
    body: 'WITH ${1:name} AS (\n  SELECT ${2:*}\n  FROM ${3:table}\n  WHERE ${4:true}\n)\nSELECT *\nFROM ${1:name};$0',
  },
  {
    name: 'recursive CTE',
    prefix: 'rcte',
    description: 'WITH RECURSIVE tree walk',
    body: 'WITH RECURSIVE ${1:tree} AS (\n  SELECT ${2:id}, ${3:parent_id}, 1 AS depth\n  FROM ${4:table}\n  WHERE ${3:parent_id} IS NULL\n  UNION ALL\n  SELECT t.${2:id}, t.${3:parent_id}, ${1:tree}.depth + 1\n  FROM ${4:table} t\n  JOIN ${1:tree} ON t.${3:parent_id} = ${1:tree}.${2:id}\n)\nSELECT * FROM ${1:tree};$0',
  },
  {
    name: 'window function: row_number',
    prefix: 'win',
    description: 'Rank rows within a partition',
    body: 'SELECT *\nFROM (\n  SELECT t.*,\n         row_number() OVER (PARTITION BY ${1:group_col} ORDER BY ${2:order_col} DESC) AS rn\n  FROM ${3:table} t\n) ranked\nWHERE rn = ${4:1};$0',
  },
  {
    name: 'window function: running total',
    prefix: 'winsum',
    description: 'Cumulative sum ordered by a column',
    body: 'SELECT ${1:id}, ${2:amount},\n       sum(${2:amount}) OVER (ORDER BY ${3:created_at} ROWS UNBOUNDED PRECEDING) AS running_total\nFROM ${4:table};$0',
  },
  {
    name: 'create index concurrently',
    prefix: 'cic',
    description: 'Build an index without blocking writes',
    body: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS ${1:idx_table_column}\n  ON ${2:table} (${3:column});$0',
  },
  {
    name: 'create table',
    prefix: 'ct',
    description: 'CREATE TABLE with a primary key and timestamps',
    body: 'CREATE TABLE ${1:name} (\n  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,\n  ${2:col} ${3:text} NOT NULL,\n  created_at timestamptz NOT NULL DEFAULT now()\n);$0',
  },
  {
    name: 'add column',
    prefix: 'addcol',
    description: 'ALTER TABLE ADD COLUMN',
    body: "ALTER TABLE ${1:table}\n  ADD COLUMN IF NOT EXISTS ${2:col} ${3:text}${4: NOT NULL DEFAULT ''};$0",
  },
  {
    name: 'explain analyze',
    prefix: 'expa',
    description: 'EXPLAIN (ANALYZE, BUFFERS) a query',
    body: 'EXPLAIN (ANALYZE, BUFFERS)\n${1:SELECT 1};$0',
  },
  {
    name: 'duplicates',
    prefix: 'dups',
    description: 'Find duplicate values in a column',
    body: 'SELECT ${1:column}, count(*) AS n\nFROM ${2:table}\nGROUP BY ${1:column}\nHAVING count(*) > 1\nORDER BY n DESC;$0',
  },
  {
    name: 'table sizes',
    prefix: 'sizes',
    description: 'Largest tables by total size',
    body: "SELECT relname, pg_size_pretty(pg_total_relation_size(oid)) AS total\nFROM pg_class\nWHERE relkind = 'r' AND relnamespace = '${1:public}'::regnamespace\nORDER BY pg_total_relation_size(oid) DESC\nLIMIT ${2:20};$0",
  },
  {
    name: 'running queries',
    prefix: 'activity',
    description: 'Active sessions from pg_stat_activity',
    body: "SELECT pid, state, now() - query_start AS running_for, left(query, 120) AS query\nFROM pg_stat_activity\nWHERE state <> 'idle' AND pid <> pg_backend_pid()\nORDER BY query_start;$0",
  },
  {
    name: 'case when',
    prefix: 'casew',
    description: 'CASE expression',
    body: 'CASE\n  WHEN ${1:condition} THEN ${2:result}\n  ELSE ${3:other}\nEND$0',
  },
];

/** Escape literal text so it inserts verbatim as a Monaco snippet body. */
export function escapeSnippetText(text: string): string {
  return text.replace(/[\\$}]/g, (c) => `\\${c}`);
}

/** Snippet body for "Save selection as snippet": literal text plus a final tab stop. */
export function snippetBodyFromSelection(selection: string): string {
  return `${escapeSnippetText(selection.replace(/\s+$/, ''))}$0`;
}

/** A snippet body as plain SQL for the documentation popup: placeholders show their defaults. */
export function previewBody(body: string): string {
  return body
    .replace(/\$\{\d+\|([^,}|]*)[^}]*\|\}/g, '$1')
    .replace(/\$\{\d+:((?:\\.|[^}\\])*)\}/g, '$1')
    .replace(/(?<!\\)\$\{?\d+\}?/g, '')
    .replace(/\\([\\$}])/g, '$1');
}

/** Suggest a trigger prefix from a snippet name: first letters, lower-case, a-z0-9 only. */
export function suggestPrefix(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0]!.slice(0, 10);
  return words
    .map((w) => w[0])
    .join('')
    .slice(0, 10);
}

/** Tab stops of a body in tab order, `$0` last. */
export function snippetTabStops(body: string): string[] {
  const seen = new Map<number, string>();
  for (const m of body.matchAll(/(?<!\\)\$(?:(\d+)|\{(\d+)(?::((?:\\.|[^}\\])*))?\})/g)) {
    const n = Number(m[1] ?? m[2]);
    if (!seen.has(n) || (!seen.get(n) && m[3])) seen.set(n, m[3] ?? '');
  }
  return [...seen.entries()]
    .sort(([a], [b]) => (a === 0 ? 1 : b === 0 ? -1 : a - b))
    .map(([n, label]) => (label ? `${n}:${label}` : String(n)));
}

/** Problem with a snippet definition, or null when it can be saved. */
export function validateSnippet(s: { name: string; prefix: string; body: string }): string | null {
  if (!s.name.trim()) return 'Name is required';
  if (!s.prefix.trim()) return 'Prefix is required';
  if (!/^[A-Za-z0-9_]+$/.test(s.prefix.trim())) return 'Prefix can only use letters, digits and _';
  if (s.prefix.trim().length > 40) return 'Prefix is too long';
  if (!s.body.trim()) return 'Body is required';
  if (s.body.length > 50_000) return 'Body is too long';
  // Unescaped `${` without a closing brace would swallow the rest in Monaco.
  let depth = 0;
  for (let i = 0; i < s.body.length; i++) {
    const c = s.body[i]!;
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '$' && s.body[i + 1] === '{') {
      depth++;
      i++;
    } else if (c === '}' && depth > 0) depth--;
  }
  return depth === 0 ? null : 'Unclosed ${…} placeholder (escape a literal $ as \\$)';
}

// ─── Import / export ─────────────────────────────────────────────────

export const SNIPPET_FILE_VERSION = 1;

export function exportSnippetsJson(list: readonly SnippetDef[]): string {
  return `${JSON.stringify(
    {
      plasmaSnippets: SNIPPET_FILE_VERSION,
      snippets: list.map((s) => ({
        name: s.name,
        prefix: s.prefix,
        description: s.description,
        body: s.body,
      })),
    },
    null,
    2,
  )}\n`;
}

export interface SnippetImport {
  snippets: SnippetDef[];
  /** One line per skipped entry. */
  skipped: string[];
}

/**
 * Accepts Plasma's own file, a bare array of snippets, or a VS Code
 * snippets file (`{ "Name": { "prefix", "body", "description" } }` with
 * `body` as a string or a list of lines). Invalid entries are skipped
 * with a reason; nothing throws on bad content.
 */
export function parseSnippetImport(text: string): SnippetImport {
  const out: SnippetImport = { snippets: [], skipped: [] };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    out.skipped.push('The file is not valid JSON.');
    return out;
  }
  const entries: Array<{ key: string; raw: unknown }> = [];
  if (Array.isArray(data)) {
    data.forEach((raw, i) => entries.push({ key: `#${i + 1}`, raw }));
  } else if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.snippets)) {
      obj.snippets.forEach((raw, i) => entries.push({ key: `#${i + 1}`, raw }));
    } else {
      for (const [key, raw] of Object.entries(obj)) {
        if (key === 'plasmaSnippets') continue;
        entries.push({ key, raw });
      }
    }
  } else {
    out.skipped.push('Expected a JSON object or array of snippets.');
    return out;
  }

  for (const { key, raw } of entries) {
    if (!raw || typeof raw !== 'object') {
      out.skipped.push(`${key}: not an object`);
      continue;
    }
    const r = raw as Record<string, unknown>;
    const body = Array.isArray(r.body)
      ? r.body.filter((l) => typeof l === 'string').join('\n')
      : typeof r.body === 'string'
        ? r.body
        : '';
    const prefixRaw = Array.isArray(r.prefix) ? r.prefix[0] : r.prefix;
    const name =
      typeof r.name === 'string' && r.name.trim() ? r.name.trim() : /^#\d+$/.test(key) ? '' : key;
    const prefix = typeof prefixRaw === 'string' ? prefixRaw.trim() : '';
    const description = typeof r.description === 'string' ? r.description.slice(0, 300) : '';
    const def = { name: name.slice(0, 120), prefix, description, body };
    const problem = validateSnippet(def);
    if (problem) {
      out.skipped.push(`${name || key}: ${problem}`);
      continue;
    }
    out.snippets.push(def);
  }
  return out;
}

/** Drop imports that duplicate an existing prefix + body. */
export function dedupeImports(
  incoming: readonly SnippetDef[],
  existing: readonly SnippetDef[],
): { fresh: SnippetDef[]; duplicates: number } {
  const have = new Set(existing.map((s) => `${s.prefix}\u0000${s.body}`));
  const fresh: SnippetDef[] = [];
  for (const s of incoming) {
    const k = `${s.prefix}\u0000${s.body}`;
    if (have.has(k)) continue;
    have.add(k);
    fresh.push(s);
  }
  return { fresh, duplicates: incoming.length - fresh.length };
}

// ─── User snippet list helpers ───────────────────────────────────────

export interface StoredSnippet extends SnippetDef {
  id: string;
  createdAt: number;
  updatedAt: number;
}

/** Completion list: user snippets first; a user snippet replaces a built-in with the same prefix. */
export function mergeSnippets(
  user: readonly SnippetDef[],
  builtin: readonly SnippetDef[] = BUILTIN_SNIPPETS,
): Array<SnippetDef & { source: 'user' | 'builtin' }> {
  const taken = new Set(user.map((s) => s.prefix.toLowerCase()));
  return [
    ...user.map((s) => ({ ...s, source: 'user' as const })),
    ...builtin
      .filter((s) => !taken.has(s.prefix.toLowerCase()))
      .map((s) => ({ ...s, source: 'builtin' as const })),
  ];
}

/** Insert or update (by id) a snippet; list order is newest first. */
export function upsertSnippet(
  list: readonly StoredSnippet[],
  draft: SnippetDef & { id?: string },
  now: number,
  newId: () => string,
): StoredSnippet[] {
  const clean = {
    name: draft.name.trim(),
    prefix: draft.prefix.trim(),
    description: draft.description.trim(),
    body: draft.body,
  };
  const existing = draft.id ? list.find((s) => s.id === draft.id) : undefined;
  if (existing) {
    return list.map((s) => (s.id === existing.id ? { ...s, ...clean, updatedAt: now } : s));
  }
  return [{ id: newId(), ...clean, createdAt: now, updatedAt: now }, ...list];
}

export function removeSnippet(list: readonly StoredSnippet[], id: string): StoredSnippet[] {
  return list.filter((s) => s.id !== id);
}

/** Another snippet already uses this prefix (case-insensitive). */
export function prefixTaken(
  list: readonly StoredSnippet[],
  prefix: string,
  exceptId?: string,
): boolean {
  const p = prefix.trim().toLowerCase();
  return list.some((s) => s.id !== exceptId && s.prefix.toLowerCase() === p);
}
