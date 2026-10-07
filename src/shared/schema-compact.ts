import { AI_SCHEMA_MAX_TABLES } from './ai-schema-policy';
import type { SchemaInfo } from './protocol';

const DEFAULT_MAX_COLS_PER_TABLE = 24;

/** Compact one-line-per-table structure text for prompts and MCP `get_schema`. */
export function compactSchema(
  schema: SchemaInfo,
  opts: { withIndexes?: boolean; maxTables?: number; maxCols?: number } = {},
): string {
  const MAX_TABLES = opts.maxTables ?? AI_SCHEMA_MAX_TABLES;
  const MAX_COLS_PER_TABLE = opts.maxCols ?? DEFAULT_MAX_COLS_PER_TABLE;
  const tables = schema.tables.slice(0, MAX_TABLES);
  const colByTable = new Map<string, SchemaInfo['columns']>();
  for (const c of schema.columns) {
    const key = `${c.schema}.${c.table}`;
    const arr = colByTable.get(key) ?? [];
    arr.push(c);
    colByTable.set(key, arr);
  }
  const fkByTable = new Map<string, string[]>();
  for (const fk of schema.foreignKeys) {
    const key = `${fk.schema}.${fk.table}`;
    const arr = fkByTable.get(key) ?? [];
    arr.push(`${fk.column} -> ${fk.refSchema}.${fk.refTable}.${fk.refColumn}`);
    fkByTable.set(key, arr);
  }
  const lines: string[] = [];
  for (const t of tables) {
    const key = `${t.schema}.${t.name}`;
    const cols = (colByTable.get(key) ?? [])
      .sort((a, b) => a.ordinal - b.ordinal)
      .slice(0, MAX_COLS_PER_TABLE);
    const colSig = cols
      .map(
        (c) =>
          `${c.name} ${c.dataType}${c.isPrimaryKey ? ' PK' : ''}${c.isNullable ? '' : ' NOT NULL'}`,
      )
      .join(', ');
    lines.push(`${key} (${colSig})`);
    const fks = fkByTable.get(key);
    if (fks && fks.length > 0) {
      lines.push(`  FK: ${fks.join('; ')}`);
    }
    if (opts.withIndexes) {
      for (const ix of schema.indexes ?? []) {
        if (`${ix.schema}.${ix.table}` === key) lines.push(`  INDEX: ${ix.definition}`);
      }
    }
  }
  if (schema.tables.length > MAX_TABLES) {
    lines.push(`-- … ${schema.tables.length - MAX_TABLES} more tables omitted for brevity`);
  }
  return lines.join('\n');
}
