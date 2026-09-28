/**
 * Turn the tagged rows from `buildDefinitionQuerySql` into the column /
 * constraint / index models the Structure view renders. Pure so it can
 * be unit-tested without a database.
 */

export interface DefinitionRow {
  kind: 'col' | 'con' | 'idx';
  c1: string;
  c2: string;
  c3: string;
  c4: string;
}

export type ConstraintType = 'primary' | 'foreign' | 'unique' | 'check' | 'exclude' | 'other';

export interface StructureConstraint {
  name: string;
  type: ConstraintType;
  columns: string[];
  /** `schema.table(col)` target for foreign keys. */
  references: string | null;
  definition: string;
}

export interface StructureIndex {
  name: string;
  unique: boolean;
  method: string;
  columns: string;
  condition: string;
  definition: string;
}

export interface StructureColumn {
  ordinal: number;
  name: string;
  type: string;
  nullable: boolean;
  defaultExpr: string;
  primaryKey: boolean;
  unique: boolean;
  references: string | null;
}

export interface TableStructure {
  columns: StructureColumn[];
  constraints: StructureConstraint[];
  indexes: StructureIndex[];
}

/** Split `a, "b c", d` on top-level commas and unquote identifiers. */
export function splitIdentList(list: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  let depth = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (ch === '"') {
      if (inQuote && list[i + 1] === '"') {
        cur += '"';
        i++;
        continue;
      }
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && ch === '(') depth++;
    if (!inQuote && ch === ')') depth--;
    if (!inQuote && depth === 0 && ch === ',') {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Contents of the parenthesised group starting at or after `from`. */
function parenGroup(text: string, from = 0): { inner: string; end: number } | null {
  const start = text.indexOf('(', from);
  if (start === -1) return null;
  let depth = 0;
  let inQuote = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') inQuote = !inQuote;
    if (inQuote) continue;
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return { inner: text.slice(start + 1, i), end: i + 1 };
    }
  }
  return null;
}

export function parseConstraint(name: string, definition: string): StructureConstraint {
  const def = definition.trim();
  const upper = def.toUpperCase();
  let type: ConstraintType = 'other';
  if (upper.startsWith('PRIMARY KEY')) type = 'primary';
  else if (upper.startsWith('FOREIGN KEY')) type = 'foreign';
  else if (upper.startsWith('UNIQUE')) type = 'unique';
  else if (upper.startsWith('CHECK')) type = 'check';
  else if (upper.startsWith('EXCLUDE')) type = 'exclude';

  let columns: string[] = [];
  let references: string | null = null;
  if (type === 'primary' || type === 'foreign' || type === 'unique') {
    const group = parenGroup(def);
    if (group) {
      columns = splitIdentList(group.inner);
      if (type === 'foreign') {
        const m = def.slice(group.end).match(/REFERENCES\s+(.+?\))/i);
        references = m ? m[1].trim() : null;
      }
    }
  }
  return { name, type, columns, references, definition: def };
}

export function parseIndex(name: string, definition: string): StructureIndex {
  const def = definition.trim();
  const unique = /^CREATE\s+UNIQUE\s+INDEX/i.test(def);
  const using = def.match(/\bUSING\s+(\w+)\s*/i);
  const method = using ? using[1].toLowerCase() : 'btree';
  const from = using ? (using.index ?? 0) + using[0].length - 1 : def.indexOf(' ON ');
  const group = parenGroup(def, Math.max(0, from));
  const rest = group ? def.slice(group.end) : '';
  const where = rest.match(/\bWHERE\s+(.+)$/i);
  return {
    name,
    unique,
    method,
    columns: group ? group.inner : '',
    condition: where ? where[1].trim() : '',
    definition: def,
  };
}

export function buildTableStructure(rows: DefinitionRow[]): TableStructure {
  const constraints = rows.filter((r) => r.kind === 'con').map((r) => parseConstraint(r.c1, r.c2));
  const indexes = rows.filter((r) => r.kind === 'idx').map((r) => parseIndex(r.c1, r.c2));

  const pk = new Set<string>();
  const uq = new Set<string>();
  const fk = new Map<string, string>();
  for (const c of constraints) {
    if (c.type === 'primary') for (const col of c.columns) pk.add(col);
    // Only single-column UNIQUE marks the column itself as unique.
    if (c.type === 'unique' && c.columns.length === 1) uq.add(c.columns[0]);
    if (c.type === 'foreign' && c.references) {
      for (const col of c.columns) fk.set(col, c.references);
    }
  }

  const columns = rows
    .filter((r) => r.kind === 'col')
    .map((r, i) => ({
      ordinal: i + 1,
      name: r.c1,
      type: r.c2,
      nullable: r.c3 !== 'NOT NULL',
      defaultExpr: r.c4,
      primaryKey: pk.has(r.c1),
      unique: uq.has(r.c1),
      references: fk.get(r.c1) ?? null,
    }));

  return { columns, constraints, indexes };
}
