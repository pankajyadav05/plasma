import {
  type ColumnSpec,
  type ConstraintSpec,
  type IndexSpec,
  type StructureChange,
  suggestUsing,
} from '@shared/pg-ddl';

/**
 * The structure editor's staged edits and how they turn into
 * `StructureChange`s. Pure, so ordering and the "type change with a
 * default" dance are unit-tested without React.
 */

export interface ColumnState {
  name: string;
  type: string;
  nullable: boolean;
  /** Default expression as shown by Postgres ('' = none). */
  default: string;
  comment: string;
  primaryKey: boolean;
}

/** What the user changed on an existing column. Absent = untouched. */
export interface ColumnEdit {
  name?: string;
  type?: string;
  /** USING expression for the type change ('' = none). */
  using?: string;
  nullable?: boolean;
  default?: string;
  comment?: string;
}

export interface EditModel {
  /** Keyed by the column's original name. */
  columnEdits: Record<string, ColumnEdit>;
  droppedColumns: string[];
  addedColumns: ColumnSpec[];
  droppedIndexes: string[];
  addedIndexes: IndexSpec[];
  droppedConstraints: string[];
  addedConstraints: ConstraintSpec[];
}

export const EMPTY_MODEL: EditModel = {
  columnEdits: {},
  droppedColumns: [],
  addedColumns: [],
  droppedIndexes: [],
  addedIndexes: [],
  droppedConstraints: [],
  addedConstraints: [],
};

export function isEmptyModel(m: EditModel): boolean {
  return (
    Object.keys(m.columnEdits).length === 0 &&
    m.droppedColumns.length === 0 &&
    m.addedColumns.length === 0 &&
    m.droppedIndexes.length === 0 &&
    m.addedIndexes.length === 0 &&
    m.droppedConstraints.length === 0 &&
    m.addedConstraints.length === 0
  );
}

export function changeCount(m: EditModel): number {
  return (
    Object.values(m.columnEdits).reduce(
      (n, e) => n + Object.values(e).filter((v) => v !== undefined).length,
      0,
    ) +
    m.droppedColumns.length +
    m.addedColumns.length +
    m.droppedIndexes.length +
    m.addedIndexes.length +
    m.droppedConstraints.length +
    m.addedConstraints.length
  );
}

/** Column as it will look after the staged edits (existing columns, then added). */
export function effectiveColumns(original: readonly ColumnState[], m: EditModel): ColumnState[] {
  const out: ColumnState[] = [];
  for (const c of original) {
    if (m.droppedColumns.includes(c.name)) continue;
    const e = m.columnEdits[c.name] ?? {};
    out.push({
      name: e.name ?? c.name,
      type: e.type ?? c.type,
      nullable: e.nullable ?? c.nullable,
      default: e.default ?? c.default,
      comment: e.comment ?? c.comment,
      primaryKey: c.primaryKey,
    });
  }
  for (const a of m.addedColumns) {
    out.push({
      name: a.name,
      type: a.type,
      nullable: a.nullable && !a.primaryKey,
      default: a.default ?? '',
      comment: a.comment ?? '',
      primaryKey: a.primaryKey === true,
    });
  }
  return out;
}

/**
 * Set one field of a column edit, dropping the edit again when the value
 * matches the original (so retyping the old value clears the change).
 */
export function setColumnEdit<K extends keyof ColumnEdit>(
  m: EditModel,
  original: ColumnState,
  key: K,
  value: ColumnEdit[K],
): EditModel {
  const cur: ColumnEdit = { ...(m.columnEdits[original.name] ?? {}) };
  const base: Partial<Record<keyof ColumnEdit, unknown>> = {
    name: original.name,
    type: original.type,
    nullable: original.nullable,
    default: original.default,
    comment: original.comment,
  };
  if (key !== 'using' && value === base[key]) delete cur[key];
  else cur[key] = value;
  // A USING expression only makes sense next to a type change.
  if (cur.type === undefined) cur.using = undefined;
  const cleaned = Object.fromEntries(Object.entries(cur).filter(([, v]) => v !== undefined));
  const next = { ...m.columnEdits };
  if (Object.keys(cleaned).length === 0) delete next[original.name];
  else next[original.name] = cleaned as ColumnEdit;
  return { ...m, columnEdits: next };
}

/** Turn the staged model into ordered changes. */
export function diffToChanges(original: readonly ColumnState[], m: EditModel): StructureChange[] {
  const out: StructureChange[] = [];
  for (const name of m.droppedConstraints) out.push({ kind: 'dropConstraint', name });
  for (const name of m.droppedIndexes) out.push({ kind: 'dropIndex', schema: '', name });
  for (const name of m.droppedColumns) out.push({ kind: 'dropColumn', name });
  for (const column of m.addedColumns) out.push({ kind: 'addColumn', column });

  const renames: StructureChange[] = [];
  for (const c of original) {
    if (m.droppedColumns.includes(c.name)) continue;
    const e = m.columnEdits[c.name];
    if (!e) continue;
    const type = e.type ?? c.type;
    const newDefault = e.default ?? c.default;
    if (e.type !== undefined) {
      // A default that can't be cast to the new type fails the ALTER; the
      // usual fix is to drop it first and put it back afterwards.
      if (c.default !== '' && e.default === undefined) {
        out.push({ kind: 'setDefault', name: c.name, type: c.type, default: null });
      }
      out.push({ kind: 'alterType', name: c.name, type, using: e.using?.trim() || null });
      if (c.default !== '' && e.default === undefined) {
        out.push({ kind: 'setDefault', name: c.name, type, default: c.default });
      }
    }
    if (e.nullable !== undefined) {
      out.push({ kind: 'setNullable', name: c.name, nullable: e.nullable });
    }
    if (e.default !== undefined) {
      out.push({
        kind: 'setDefault',
        name: c.name,
        type,
        default: newDefault.trim() === '' ? null : newDefault,
      });
    }
    if (e.comment !== undefined) {
      out.push({ kind: 'setComment', name: c.name, comment: e.comment.trim() || null });
    }
    if (e.name !== undefined && e.name !== c.name) {
      renames.push({ kind: 'renameColumn', from: c.name, to: e.name });
    }
  }
  out.push(...renames);
  for (const constraint of m.addedConstraints) out.push({ kind: 'addConstraint', constraint });
  for (const index of m.addedIndexes) out.push({ kind: 'addIndex', index });
  return out;
}

/** Fill in the schema the model does not know about (dropIndex needs it). */
export function withSchema(changes: StructureChange[], schema: string): StructureChange[] {
  return changes.map((c) => (c.kind === 'dropIndex' && c.schema === '' ? { ...c, schema } : c));
}

/** The USING text to pre-fill when a column's type is edited. */
export function usingHint(column: string, fromType: string, toType: string): string {
  try {
    return suggestUsing(column, fromType, toType) ?? '';
  } catch {
    return '';
  }
}
