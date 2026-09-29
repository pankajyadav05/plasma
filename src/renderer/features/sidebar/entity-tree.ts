/**
 * Flat row model for the Items sidebar (PC2 / PC4 / PC5 / PF15).
 *
 * The tree is flattened into uniform 24px rows so it can be windowed and
 * walked with the keyboard:
 *   - relations of the current schema (tables, views, …), favourites
 *     first; partition children nest under their partitioned parent
 *   - collapsible sections for functions, procedures, sequences, types
 *     and extensions
 * Searching is fuzzy; a search expands every section with a match and
 * lists matching partitions at the top level.
 */
import type { SchemaInfo } from '@shared/protocol';
import { fuzzyFilter } from './fuzzy';

export type RelationKind = SchemaInfo['tables'][number]['kind'];
export type ObjectKind =
  | RelationKind
  | 'function'
  | 'procedure'
  | 'sequence'
  | 'type'
  | 'extension';
export type SectionKind = 'function' | 'procedure' | 'sequence' | 'type' | 'extension';

type Table = SchemaInfo['tables'][number];
type Routine = SchemaInfo['routines'][number];
type Sequence = SchemaInfo['sequences'][number];
type TypeInfo = SchemaInfo['types'][number];
type Extension = SchemaInfo['extensions'][number];

export type TreeRow =
  | {
      type: 'relation';
      key: string;
      level: 1 | 2;
      table: Table;
      favorite: boolean;
      /** Partition count when this is a partitioned parent. */
      childCount: number;
      expanded: boolean;
      parentKey: string | null;
    }
  | {
      type: 'section';
      key: string;
      level: 1;
      section: SectionKind;
      label: string;
      count: number;
      expanded: boolean;
      parentKey: null;
    }
  | { type: 'routine'; key: string; level: 2; routine: Routine; parentKey: string }
  | { type: 'sequence'; key: string; level: 2; sequence: Sequence; parentKey: string }
  | { type: 'type'; key: string; level: 2; typeInfo: TypeInfo; parentKey: string }
  | { type: 'extension'; key: string; level: 2; extension: Extension; parentKey: string };

export const SECTION_LABELS: Record<SectionKind, string> = {
  function: 'Functions',
  procedure: 'Procedures',
  sequence: 'Sequences',
  type: 'Types',
  extension: 'Extensions',
};

const SECTION_ORDER: SectionKind[] = ['function', 'procedure', 'sequence', 'type', 'extension'];

export const relationKey = (schema: string, name: string) => `rel:${schema}.${name}`;
export const sectionKey = (s: SectionKind) => `sec:${s}`;

export interface TreeInput {
  schema: SchemaInfo;
  currentSchema: string;
  filter: ReadonlySet<string>;
  search: string;
  favorites: ReadonlySet<string>;
  /** Expanded section / partitioned-parent keys. */
  expanded: ReadonlySet<string>;
}

export function buildEntityRows(input: TreeInput): TreeRow[] {
  const { schema, currentSchema, filter, favorites, expanded } = input;
  const search = input.search.trim();
  const searching = search.length > 0;
  const rows: TreeRow[] = [];

  const inSchema = schema.tables.filter((t) => t.schema === currentSchema);
  const isChild = (t: Table) =>
    Boolean(t.partitionOf) &&
    inSchema.some((p) => p.schema === t.partitionOf?.schema && p.name === t.partitionOf?.name);
  const childrenOf = new Map<string, Table[]>();
  for (const t of inSchema) {
    if (!t.partitionOf) continue;
    const k = relationKey(t.partitionOf.schema, t.partitionOf.name);
    const list = childrenOf.get(k) ?? [];
    list.push(t);
    childrenOf.set(k, list);
  }

  const favRank = (t: Table) => (favorites.has(`${t.schema}.${t.name}`) ? 0 : 1);
  let relations = inSchema.filter((t) => filter.has(t.kind));
  if (searching) {
    // Fuzzy rank, then favourites float within the ranked list.
    relations = fuzzyFilter(relations, search, (t) => t.name);
    relations = relations
      .map((t, i) => ({ t, i }))
      .sort((a, b) => favRank(a.t) - favRank(b.t) || a.i - b.i)
      .map((x) => x.t);
  } else {
    relations = relations
      .filter((t) => !isChild(t))
      .sort((a, b) => favRank(a) - favRank(b) || a.name.localeCompare(b.name));
  }

  for (const t of relations) {
    const key = relationKey(t.schema, t.name);
    const children = searching ? [] : (childrenOf.get(key) ?? []);
    const open = children.length > 0 && expanded.has(key);
    rows.push({
      type: 'relation',
      key,
      level: 1,
      table: t,
      favorite: favorites.has(`${t.schema}.${t.name}`),
      childCount: children.length,
      expanded: open,
      parentKey: null,
    });
    if (open) {
      for (const c of [...children].sort((a, b) => a.name.localeCompare(b.name))) {
        rows.push({
          type: 'relation',
          key: relationKey(c.schema, c.name),
          level: 2,
          table: c,
          favorite: favorites.has(`${c.schema}.${c.name}`),
          childCount: 0,
          expanded: false,
          parentKey: key,
        });
      }
    }
  }

  for (const section of SECTION_ORDER) {
    if (!filter.has(section)) continue;
    const items = sectionItems(schema, section, currentSchema, search);
    if (items.length === 0) continue;
    const key = sectionKey(section);
    const open = searching || expanded.has(key);
    rows.push({
      type: 'section',
      key,
      level: 1,
      section,
      label: SECTION_LABELS[section],
      count: items.length,
      expanded: open,
      parentKey: null,
    });
    if (!open) continue;
    for (const row of items) rows.push({ ...row, parentKey: key } as TreeRow);
  }
  return rows;
}

type ChildRow = Exclude<TreeRow, { type: 'relation' } | { type: 'section' }>;

function sectionItems(
  schema: SchemaInfo,
  section: SectionKind,
  currentSchema: string,
  search: string,
): Array<Omit<ChildRow, 'parentKey'>> {
  switch (section) {
    case 'function':
    case 'procedure': {
      const list = (schema.routines ?? []).filter(
        (r) => r.schema === currentSchema && r.kind === section,
      );
      return fuzzyFilter(list, search, (r) => r.name).map((routine) => ({
        type: 'routine' as const,
        key: `fn:${routine.oid}`,
        level: 2 as const,
        routine,
      }));
    }
    case 'sequence': {
      const list = (schema.sequences ?? []).filter((s) => s.schema === currentSchema);
      return fuzzyFilter(list, search, (s) => s.name).map((sequence) => ({
        type: 'sequence' as const,
        key: `seq:${sequence.schema}.${sequence.name}`,
        level: 2 as const,
        sequence,
      }));
    }
    case 'type': {
      const list = (schema.types ?? []).filter((t) => t.schema === currentSchema);
      return fuzzyFilter(list, search, (t) => t.name).map((typeInfo) => ({
        type: 'type' as const,
        key: `type:${typeInfo.schema}.${typeInfo.name}`,
        level: 2 as const,
        typeInfo,
      }));
    }
    case 'extension': {
      // Extensions are database-wide — listed whatever schema is selected.
      return fuzzyFilter(schema.extensions ?? [], search, (e) => e.name).map((extension) => ({
        type: 'extension' as const,
        key: `ext:${extension.name}`,
        level: 2 as const,
        extension,
      }));
    }
  }
}

/** Display name of a row (used for type-ahead, labels and titles). */
export function rowName(row: TreeRow): string {
  switch (row.type) {
    case 'relation':
      return row.table.name;
    case 'section':
      return row.label;
    case 'routine':
      return row.routine.name;
    case 'sequence':
      return row.sequence.name;
    case 'type':
      return row.typeInfo.name;
    case 'extension':
      return row.extension.name;
  }
}

export type TreeKeyAction =
  | { kind: 'focus'; index: number }
  | { kind: 'expand'; key: string }
  | { kind: 'collapse'; key: string; focus?: number }
  | { kind: 'activate'; index: number }
  | null;

/**
 * WAI-ARIA tree keyboard model over the flat rows: ↑/↓ move, Home/End
 * jump, → expands (or steps into the first child), ← collapses (or
 * steps to the parent), Enter activates.
 */
export function treeKeyAction(rows: readonly TreeRow[], index: number, key: string): TreeKeyAction {
  if (rows.length === 0) return null;
  const clamp = (i: number) => Math.max(0, Math.min(rows.length - 1, i));
  const row = rows[index];
  switch (key) {
    case 'ArrowDown':
      return { kind: 'focus', index: clamp(index + 1) };
    case 'ArrowUp':
      return { kind: 'focus', index: clamp(index - 1) };
    case 'Home':
      return { kind: 'focus', index: 0 };
    case 'End':
      return { kind: 'focus', index: rows.length - 1 };
    case 'ArrowRight': {
      if (!row) return null;
      const expandable = row.type === 'section' || (row.type === 'relation' && row.childCount > 0);
      if (!expandable) return null;
      const open = row.type === 'section' || row.type === 'relation' ? row.expanded : false;
      if (!open) return { kind: 'expand', key: row.key };
      return rows[index + 1]?.parentKey === row.key ? { kind: 'focus', index: index + 1 } : null;
    }
    case 'ArrowLeft': {
      if (!row) return null;
      const open = (row.type === 'section' || row.type === 'relation') && row.expanded;
      if (open) return { kind: 'collapse', key: row.key };
      if (row.parentKey) {
        const parent = rows.findIndex((r) => r.key === row.parentKey);
        if (parent !== -1) return { kind: 'focus', index: parent };
      }
      return null;
    }
    case 'Enter':
      return row ? { kind: 'activate', index } : null;
    default:
      return null;
  }
}
