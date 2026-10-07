import type { PendingEdit } from '@/stores/session-types';

/**
 * Concurrent-edit conflicts (B1). When a commit finds that a row changed on the
 * server since the grid loaded it, the worker rolls the whole batch back and
 * names the statements that matched nothing. This module turns that into
 * something reviewable: per row, what the user changed ("mine"), what the
 * server holds now ("theirs") and what the grid loaded ("original"), plus the
 * two ways to resolve it. Everything here is pure; the store does the I/O.
 */

/** What the worker reports: statement `index` (of the batch) matched no row, or an INSERT hit a unique key. */
export interface WorkerConflict {
  index: number;
  reason: 'no-match' | 'duplicate';
}

export interface TheirsCell {
  column: string;
  value: string | null;
  type?: string;
}

/** The server's current row for a key. */
export type TheirsLookup =
  | { found: true; row: TheirsCell[] }
  | { found: false }
  | { error: string };

export interface ConflictColumn {
  column: string;
  original: string | null | undefined;
  /** The user's new value (undefined for a delete). */
  mine: string | null | undefined;
  /** The server's current value (undefined when the row is gone or unknown). */
  theirs: string | null | undefined;
  /** The server value differs from what the grid loaded. */
  changedByOther: boolean;
}

export type ConflictKind =
  /** The row exists but holds other values than the grid loaded. */
  | 'changed'
  /** The row no longer exists. */
  | 'gone'
  /** An INSERT collides with an existing key. */
  | 'duplicate'
  /** The current row could not be read; nothing can be compared. */
  | 'unknown';

export interface EditConflict {
  /** Stable within one review: `row:<rowKey>` or `insert:<editId>`. */
  id: string;
  op: 'update' | 'delete' | 'insert';
  kind: ConflictKind;
  schema: string;
  table: string;
  /** `id=5` / `a=1, b=2`; `new row` for an insert. */
  rowLabel: string;
  /** The staged edits this conflict holds up. */
  editIds: string[];
  columns: ConflictColumn[];
  /** The server's current row (kind `changed`), used to re-stage. */
  theirsRow?: TheirsCell[];
}

export interface BatchShape {
  editIds: string[][];
  updates: Array<{ kind?: 'update' | 'delete' | 'insert' }>;
}

function kindOf(e: PendingEdit): 'update' | 'delete' | 'insert' {
  return e.kind ?? 'update';
}

function asText(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return typeof v === 'string' ? v : String(v);
}

function rowLabelOf(e: PendingEdit): string {
  if (kindOf(e) === 'insert') return 'new row';
  return Object.entries(e.pkValues)
    .map(([k, v]) => `${k}=${v === null ? 'NULL' : String(v)}`)
    .join(', ');
}

/** Build the review list for the statements the worker flagged. */
export function buildConflicts(input: {
  edits: readonly PendingEdit[];
  batch: BatchShape;
  conflicts: readonly WorkerConflict[];
  theirs: ReadonlyMap<number, TheirsLookup>;
}): EditConflict[] {
  const byId = new Map(input.edits.map((e) => [e.id, e] as const));
  const out: EditConflict[] = [];
  for (const c of input.conflicts) {
    const ids = input.batch.editIds[c.index] ?? [];
    const group = ids.map((id) => byId.get(id)).filter((e): e is PendingEdit => Boolean(e));
    const first = group[0];
    if (!first) continue;
    const op = kindOf(first);
    const base = {
      op,
      schema: first.schema,
      table: first.table,
      rowLabel: rowLabelOf(first),
      editIds: ids,
    };
    if (op === 'insert' || c.reason === 'duplicate') {
      out.push({
        ...base,
        id: `insert:${first.id}`,
        kind: 'duplicate',
        columns: Object.entries(first.values ?? {}).map(([column, value]) => ({
          column,
          original: undefined,
          mine: value,
          theirs: undefined,
          changedByOther: false,
        })),
      });
      continue;
    }
    const lookup = input.theirs.get(c.index);
    const id = `row:${first.rowKey ?? first.id}`;
    if (!lookup || 'error' in lookup) {
      out.push({ ...base, id, kind: 'unknown', columns: columnsOf(group, op, undefined) });
      continue;
    }
    if (!lookup.found) {
      out.push({ ...base, id, kind: 'gone', columns: columnsOf(group, op, undefined) });
      continue;
    }
    out.push({
      ...base,
      id,
      kind: 'changed',
      columns: columnsOf(group, op, lookup.row),
      theirsRow: lookup.row,
    });
  }
  return out;
}

function columnsOf(
  group: readonly PendingEdit[],
  op: 'update' | 'delete',
  theirsRow: readonly TheirsCell[] | undefined,
): ConflictColumn[] {
  const theirsOf = (column: string): string | null | undefined =>
    theirsRow?.find((c) => c.column === column)?.value;
  if (op === 'update') {
    return group.map((e) => {
      const original = asText(e.oldValue);
      const theirs = theirsRow ? theirsOf(e.column) : undefined;
      return {
        column: e.column,
        original,
        mine: e.newValue,
        theirs,
        changedByOther: theirsRow ? theirs !== original : false,
      };
    });
  }
  const del = group[0];
  const rows = del?.originalRow ?? [];
  const all = rows.map((c) => {
    const theirs = theirsRow ? theirsOf(c.column) : undefined;
    return {
      column: c.column,
      original: c.value,
      mine: undefined,
      theirs,
      changedByOther: theirsRow ? theirs !== c.value : false,
    } satisfies ConflictColumn;
  });
  // A delete shows what moved; with nothing visibly different, show nothing.
  return theirsRow ? all.filter((c) => c.changedByOther) : all;
}

/** Whether "Keep mine" can be offered: the server row is known and exists. */
export function canKeepMine(c: EditConflict): boolean {
  return c.kind === 'changed' && Boolean(c.theirsRow) && c.op !== 'insert';
}

/**
 * Keep mine: the same change, re-staged against what the server holds now. The
 * original values become the server's, so the next commit only trips if the
 * row changes again. When the server's values look identical to the old
 * originals (the difference was invisible, e.g. a type the guard compares
 * differently than the grid prints it), the edit stops being compared so the
 * user is not stuck in a loop.
 */
export function keepMine(edits: readonly PendingEdit[], c: EditConflict): PendingEdit[] {
  if (!canKeepMine(c)) return edits.slice();
  const theirs = c.theirsRow ?? [];
  const theirsOf = (column: string) => theirs.find((t) => t.column === column);
  const mine = new Set(c.editIds);
  return edits.map((e) => {
    if (!mine.has(e.id)) return e;
    if (kindOf(e) === 'update') {
      const t = theirsOf(e.column);
      if (!t) return { ...e, unguarded: true };
      const same = asText(e.oldValue) === t.value;
      return {
        ...e,
        oldValue: t.value,
        ...(t.type ? { oldType: t.type } : {}),
        ...(same ? { unguarded: true } : {}),
      };
    }
    if (kindOf(e) === 'delete') {
      const before = e.originalRow ?? [];
      const same =
        before.length === theirs.length &&
        before.every((b) => theirsOf(b.column)?.value === b.value);
      return {
        ...e,
        originalRow: theirs.map((t) => ({ ...t })),
        ...(same ? { unguarded: true } : {}),
      };
    }
    return e;
  });
}

/** Take theirs: drop this row's staged changes and let the server's row stand. */
export function takeTheirs(edits: readonly PendingEdit[], c: EditConflict): PendingEdit[] {
  const drop = new Set(c.editIds);
  return edits.filter((e) => !drop.has(e.id));
}

/** One line for the banner: what happened and what to do. */
export function conflictSummary(conflicts: readonly EditConflict[]): string {
  const n = conflicts.length;
  const gone = conflicts.filter((c) => c.kind === 'gone').length;
  const dup = conflicts.filter((c) => c.kind === 'duplicate').length;
  const changed = n - gone - dup;
  const parts: string[] = [];
  if (changed > 0)
    parts.push(`${changed} row${changed === 1 ? ' was' : 's were'} changed by someone else`);
  if (gone > 0) parts.push(`${gone} row${gone === 1 ? ' was' : 's were'} deleted`);
  if (dup > 0)
    parts.push(`${dup} new row${dup === 1 ? ' uses' : 's use'} a key that already exists`);
  const text = parts.join('; ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}. Review them to continue.`;
}
