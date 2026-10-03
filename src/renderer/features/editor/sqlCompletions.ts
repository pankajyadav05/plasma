import { useSession } from '@/stores/session';
import { useWorkspace } from '@/stores/workspace';
import type { SchemaInfo } from '@shared/protocol';
import { mergeSnippets, previewBody } from '@shared/snippets';
import type * as MonacoType from 'monaco-editor';

/**
 * Per-introspection lookups, built once per `schema` object (F14) rather
 * than scanning every column of the database on each completion request.
 */
interface SchemaIndex {
  qualifiedTables: { qualified: string; rows: number | null }[];
  columnNames: string[];
  tablesBySchema: Map<string, SchemaInfo['tables']>;
  columnsByTable: Map<string, SchemaInfo['columns']>;
}

const indexCache = new WeakMap<SchemaInfo, SchemaIndex>();

function schemaIndex(schema: SchemaInfo): SchemaIndex {
  const hit = indexCache.get(schema);
  if (hit) return hit;
  const tablesBySchema = new Map<string, SchemaInfo['tables']>();
  for (const t of schema.tables) {
    const list = tablesBySchema.get(t.schema) ?? [];
    list.push(t);
    tablesBySchema.set(t.schema, list);
  }
  const columnsByTable = new Map<string, SchemaInfo['columns']>();
  const names = new Set<string>();
  for (const c of schema.columns) {
    names.add(c.name);
    for (const key of [`${c.schema}.${c.table}`, c.table]) {
      const list = columnsByTable.get(key) ?? [];
      list.push(c);
      columnsByTable.set(key, list);
    }
  }
  const index: SchemaIndex = {
    qualifiedTables: schema.tables.map((t) => ({
      qualified: t.schema === 'public' ? t.name : `${t.schema}.${t.name}`,
      rows: t.rowCountEstimate,
    })),
    columnNames: [...names],
    tablesBySchema,
    columnsByTable,
  };
  indexCache.set(schema, index);
  return index;
}

/**
 * Schema-aware SQL autocomplete. Registered once per renderer lifetime;
 * each completion request re-reads `useSession.getState().schema` so
 * reconnecting to a different database updates suggestions without
 * re-registering.
 *
 * Context rules:
 *   1. Dotted access (`alias.` or `schema.`) — suggest the columns of
 *      the matching table / the tables of the matching schema.
 *   2. Bare identifier after `FROM / JOIN / UPDATE / INTO` — suggest
 *      tables (qualified only when schema isn't `public`).
 *   3. Everywhere else — suggest tables + column names + SQL keywords.
 *
 * The provider does NOT try to parse SQL. It walks back ~400 chars
 * before the cursor with cheap regexes to decide context. Good enough
 * for 90% of real typing, and never blocks on big queries.
 */

let registered = false;

export function registerSqlCompletions(monaco: typeof MonacoType): void {
  if (registered) return;
  registered = true;
  registerSnippetCompletions(monaco);

  monaco.languages.registerCompletionItemProvider('sql', {
    // Only '.' — a ' ' trigger rebuilt every suggestion on each space (F14);
    // Monaco's quick suggestions still open as soon as a word starts.
    triggerCharacters: ['.'],
    provideCompletionItems: (model, position) => {
      const schema = useSession.getState().schema;
      if (!schema) return { suggestions: [] };
      const idx = schemaIndex(schema);

      const line = model.getLineContent(position.lineNumber);
      const beforeCursor = line.slice(0, position.column - 1);
      // Walk back up to ~400 chars for FROM/JOIN context detection
      const startLine = Math.max(1, position.lineNumber - 20);
      const precedingText = model.getValueInRange({
        startLineNumber: startLine,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });

      const word = model.getWordUntilPosition(position);
      const range: MonacoType.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      // ── 1. Dotted access: `alias.` or `schema.` ──
      const dotMatch = /([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)?$/.exec(beforeCursor);
      if (dotMatch) {
        const prefix = dotMatch[1];
        // First guess: prefix is a schema name → list its tables
        const schemaTables = idx.tablesBySchema.get(prefix) ?? [];
        if (schemaTables.length > 0) {
          return {
            suggestions: schemaTables.map((t) => ({
              label: t.name,
              kind: monaco.languages.CompletionItemKind.Class,
              insertText: t.name,
              range,
              detail: `table · ${prefix}.${t.name}`,
              sortText: `0_${t.name}`,
            })),
          };
        }
        // Second guess: prefix is a table name or alias used in FROM
        const target = resolveAlias(precedingText, prefix);
        if (target) {
          // Schema-qualified when the FROM clause said so; otherwise the
          // table as resolved on the search path (public first).
          const cols =
            idx.columnsByTable.get(`${target.schema ?? 'public'}.${target.table}`) ??
            idx.columnsByTable.get(target.table) ??
            [];
          return {
            suggestions: cols.map((c) => ({
              label: c.name,
              kind: monaco.languages.CompletionItemKind.Field,
              insertText: c.name,
              range,
              detail: `${c.dataType}${c.isPrimaryKey ? ' · pk' : ''}${c.isNullable ? '' : ' · not null'}`,
              sortText: `0_${c.ordinal.toString().padStart(4, '0')}`,
            })),
          };
        }
        // Fallback: no match — suggest nothing rather than spamming
        return { suggestions: [] };
      }

      // ── 2. After FROM / JOIN / UPDATE / INTO / ONLY / TABLE ──
      // Match the last such keyword in the preceding text that isn't
      // already followed by a complete identifier.
      const afterKeyword =
        /\b(from|join|update|into|only|table|describe)\s+([a-zA-Z_][a-zA-Z0-9_]*)?$/i.test(
          precedingText,
        );
      if (afterKeyword) {
        return {
          suggestions: idx.qualifiedTables.map(({ qualified, rows }) => ({
            label: qualified,
            kind: monaco.languages.CompletionItemKind.Class,
            insertText: qualified,
            range,
            detail: `table${rows !== null && rows >= 0 ? ` · ~${formatRows(rows)} rows` : ''}`,
            sortText: `0_${qualified}`,
          })),
        };
      }

      // ── 3. General: tables + columns + keywords ──
      const tableSuggestions = idx.qualifiedTables.map(({ qualified }) => {
        return {
          label: qualified,
          kind: monaco.languages.CompletionItemKind.Class,
          insertText: qualified,
          range,
          detail: 'table',
          sortText: `1_${qualified}`,
        };
      });
      // Deduplicate column names so each unique name shows once
      // (cross-table duplicates are common — `id`, `name`, `created_at`).
      const columnSuggestions = idx.columnNames.map((name) => ({
        label: name,
        kind: monaco.languages.CompletionItemKind.Field,
        insertText: name,
        range,
        detail: 'column',
        sortText: `2_${name}`,
      }));
      const keywordSuggestions = SQL_KEYWORDS.map((kw) => ({
        label: kw,
        kind: monaco.languages.CompletionItemKind.Keyword,
        insertText: kw,
        range,
        detail: 'keyword',
        sortText: `3_${kw}`,
      }));

      return {
        suggestions: [...tableSuggestions, ...columnSuggestions, ...keywordSuggestions],
      };
    },
  });
}

/**
 * Snippets (built-in + the user's) as completions: the prefix is what you
 * type, the name and description show beside it, and accepting one starts
 * a tab-stop session. Re-reads the user's list on every request, so edits
 * in the Snippets panel apply immediately.
 */
function registerSnippetCompletions(monaco: typeof MonacoType): void {
  monaco.languages.registerCompletionItemProvider('sql', {
    provideCompletionItems: (model, position) => {
      const word = model.getWordUntilPosition(position);
      // `alias.col` / `schema.table` positions are the schema provider's.
      if (word.startColumn > 1) {
        const before = model.getValueInRange({
          startLineNumber: position.lineNumber,
          startColumn: word.startColumn - 1,
          endLineNumber: position.lineNumber,
          endColumn: word.startColumn,
        });
        if (before === '.') return { suggestions: [] };
      }
      const range: MonacoType.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      // Snippets shared by an open team workspace come along with the user's own.
      const shared = useWorkspace.getState().snapshot?.snippets ?? [];
      const user = [...(useSession.getState().settings.snippets ?? []), ...shared];
      return {
        suggestions: mergeSnippets(user).map((sn) => ({
          label: { label: sn.prefix, description: sn.name },
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: sn.body,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          detail: `${sn.source === 'user' ? 'your snippet' : 'snippet'} · ${sn.name}`,
          documentation: {
            value: `${sn.description ? `${sn.description}\n\n` : ''}\`\`\`sql\n${previewBody(sn.body)}\n\`\`\``,
          },
          filterText: sn.prefix,
          sortText: `0_${sn.prefix}`,
          range,
        })),
      };
    },
  });
}

/**
 * Given some SQL text preceding the cursor and a bare identifier the
 * user typed a `.` after, try to resolve what table that identifier
 * refers to. Handles the two common patterns:
 *
 *   FROM users u    →  `u`  → `users`
 *   FROM orders     →  `orders` → `orders`
 *
 * Also handles `FROM public.users u` by stripping the schema qualifier.
 */
function resolveAlias(
  precedingText: string,
  identifier: string,
): { schema: string | null; table: string } | null {
  // Walk FROM/JOIN occurrences and pair table names with their aliases
  const re =
    /\b(?:from|join|update|into)\s+(?:([a-zA-Z_][a-zA-Z0-9_]*)\.)?([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+(?:as\s+)?([a-zA-Z_][a-zA-Z0-9_]*))?/gi;
  for (const match of precedingText.matchAll(re)) {
    const schemaName = match[1] ?? null;
    const table = match[2]!;
    const alias = match[3];
    if (alias === identifier) return { schema: schemaName, table };
    if (!alias && table === identifier) return { schema: schemaName, table };
  }
  return null;
}

function formatRows(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(0)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}

const SQL_KEYWORDS = [
  'SELECT',
  'FROM',
  'WHERE',
  'JOIN',
  'LEFT JOIN',
  'RIGHT JOIN',
  'INNER JOIN',
  'OUTER JOIN',
  'ON',
  'GROUP BY',
  'ORDER BY',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'DISTINCT',
  'INSERT INTO',
  'VALUES',
  'UPDATE',
  'SET',
  'DELETE FROM',
  'RETURNING',
  'CREATE TABLE',
  'ALTER TABLE',
  'DROP TABLE',
  'INDEX',
  'WITH',
  'UNION',
  'UNION ALL',
  'INTERSECT',
  'EXCEPT',
  'AS',
  'AND',
  'OR',
  'NOT',
  'IN',
  'BETWEEN',
  'LIKE',
  'ILIKE',
  'IS NULL',
  'IS NOT NULL',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'COUNT(*)',
];
