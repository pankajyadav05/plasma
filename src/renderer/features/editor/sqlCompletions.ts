import type * as MonacoType from 'monaco-editor';
import { useSession } from '@/stores/session';

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

  monaco.languages.registerCompletionItemProvider('sql', {
    triggerCharacters: ['.', ' '],
    provideCompletionItems: (model, position) => {
      const schema = useSession.getState().schema;
      if (!schema) return { suggestions: [] };

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
      const dotMatch = /([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)?$/.exec(
        beforeCursor,
      );
      if (dotMatch) {
        const prefix = dotMatch[1];
        // First guess: prefix is a schema name → list its tables
        const schemaTables = schema.tables.filter((t) => t.schema === prefix);
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
        const tableName = resolveAlias(precedingText, prefix);
        if (tableName) {
          const cols = schema.columns.filter(
            (c) => c.table === tableName && !isHidden(precedingText, c.schema),
          );
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
          suggestions: schema.tables.map((t) => {
            const qualified = t.schema === 'public' ? t.name : `${t.schema}.${t.name}`;
            return {
              label: qualified,
              kind: monaco.languages.CompletionItemKind.Class,
              insertText: qualified,
              range,
              detail: `table${t.rowCountEstimate !== null && t.rowCountEstimate >= 0 ? ` · ~${formatRows(t.rowCountEstimate)} rows` : ''}`,
              sortText: `0_${qualified}`,
            };
          }),
        };
      }

      // ── 3. General: tables + columns + keywords ──
      const tableSuggestions = schema.tables.map((t) => {
        const qualified = t.schema === 'public' ? t.name : `${t.schema}.${t.name}`;
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
      const colNames = new Set<string>();
      for (const c of schema.columns) colNames.add(c.name);
      const columnSuggestions = [...colNames].map((name) => ({
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
        suggestions: [
          ...tableSuggestions,
          ...columnSuggestions,
          ...keywordSuggestions,
        ],
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
function resolveAlias(precedingText: string, identifier: string): string | null {
  // Walk FROM/JOIN occurrences and pair table names with their aliases
  const re = /\b(?:from|join|update|into)\s+(?:([a-zA-Z_][a-zA-Z0-9_]*)\.)?([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+(?:as\s+)?([a-zA-Z_][a-zA-Z0-9_]*))?/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(precedingText))) {
    const table = match[2];
    const alias = match[3];
    if (alias === identifier) return table;
    if (!alias && table === identifier) return table;
  }
  return null;
}

function isHidden(_text: string, _schema: string): boolean {
  // Placeholder for future smarts (e.g. omit columns the user's SELECT
  // already mentions). For now show everything.
  return false;
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
