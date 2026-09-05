import type { SchemaInfo } from '@shared/protocol';

/**
 * If the text before the cursor looks like `column =` or `column IN (`
 * (optionally already inside the paren with trailing comma/space), and
 * that column's type is a known enum, return its labels.
 */
export function enumLabelsForContext(
  schema: SchemaInfo,
  beforeCursor: string,
  precedingText: string,
): string[] | null {
  const enums = schema.enums ?? [];
  if (enums.length === 0) return null;

  // `col =` / `alias.col =` / `col IN (` / `col IN ( 'x',`
  const match =
    /(?:^|[^a-zA-Z0-9_])(?:([a-zA-Z_][a-zA-Z0-9_]*)\.)?([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:=\s*|in\s*\(\s*(?:'(?:[^']|'')*'\s*,\s*)*)$/i.exec(
      beforeCursor,
    );
  if (!match) return null;

  const aliasOrTable = match[1];
  const columnName = match[2];

  let candidates = schema.columns.filter((c) => c.name === columnName);
  if (aliasOrTable) {
    const tableName = resolveAlias(precedingText, aliasOrTable) ?? aliasOrTable;
    candidates = candidates.filter((c) => c.table === tableName || c.schema === aliasOrTable);
  }

  for (const col of candidates) {
    const labels = labelsForDataType(enums, col.dataType);
    if (labels) return labels;
  }
  return null;
}

/** Match a column `dataType` (from format_type) to an introspected enum. */
export function labelsForDataType(
  enums: SchemaInfo['enums'],
  dataType: string,
): string[] | null {
  const normalized = dataType.trim().toLowerCase();
  for (const e of enums) {
    const bare = e.name.toLowerCase();
    const qualified = `${e.schema}.${e.name}`.toLowerCase();
    if (normalized === bare || normalized === qualified) {
      return e.labels;
    }
  }
  return null;
}

function resolveAlias(precedingText: string, identifier: string): string | null {
  const re =
    /\b(?:from|join|update|into)\s+(?:([a-zA-Z_][a-zA-Z0-9_]*)\.)?([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+(?:as\s+)?([a-zA-Z_][a-zA-Z0-9_]*))?/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(precedingText))) {
    const table = match[2];
    const alias = match[3];
    if (alias === identifier) return table;
    if (!alias && table === identifier) return table;
  }
  return null;
}
