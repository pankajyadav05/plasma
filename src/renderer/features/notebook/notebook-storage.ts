/**
 * Notebook draft persistence. Drafts are keyed per connection so two
 * databases never share (or clobber) one notebook. Older builds stored a
 * single global draft under `LEGACY_DRAFT_KEY`; it is migrated into the
 * first connection that opens the notebook with an empty draft, then
 * removed.
 */

export type NotebookCellKind = 'sql' | 'md';

export interface StoredCell {
  id: string;
  kind: NotebookCellKind;
  content: string;
}

export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const LEGACY_DRAFT_KEY = 'plasma:notebook:draft';
const DRAFT_KEY_PREFIX = 'plasma.notebook.draft';
const NO_CONNECTION = 'default';

export function draftKey(connectionId: string | null | undefined): string {
  return `${DRAFT_KEY_PREFIX}:${connectionId || NO_CONNECTION}`;
}

/** Parse a stored draft, dropping anything that isn't a well-formed cell. */
export function parseCells(raw: string | null): StoredCell[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: StoredCell[] = [];
    for (const c of parsed) {
      if (!c || typeof c !== 'object') continue;
      const { id, kind, content } = c as Record<string, unknown>;
      if (typeof id !== 'string' || (kind !== 'sql' && kind !== 'md')) continue;
      out.push({ id, kind, content: typeof content === 'string' ? content : '' });
    }
    return out;
  } catch {
    return [];
  }
}

function safeGet(storage: DraftStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Load the draft for `connectionId`. When it is empty and a legacy global
 * draft exists, the legacy cells are adopted (written under the
 * per-connection key) and the legacy key is removed.
 */
export function loadDraft(
  storage: DraftStorage,
  connectionId: string | null | undefined,
): StoredCell[] {
  const key = draftKey(connectionId);
  const own = parseCells(safeGet(storage, key));
  if (own.length > 0) return own;
  const legacyRaw = safeGet(storage, LEGACY_DRAFT_KEY);
  if (legacyRaw === null) return own;
  const legacy = parseCells(legacyRaw);
  try {
    if (legacy.length > 0) storage.setItem(key, JSON.stringify(legacy));
    storage.removeItem(LEGACY_DRAFT_KEY);
  } catch {
    // Storage disabled / full — still hand back the legacy cells.
  }
  return legacy;
}

export function saveDraft(
  storage: DraftStorage,
  connectionId: string | null | undefined,
  cells: readonly StoredCell[],
): void {
  const key = draftKey(connectionId);
  try {
    if (cells.length === 0) storage.removeItem(key);
    else
      storage.setItem(
        key,
        JSON.stringify(cells.map((c) => ({ id: c.id, kind: c.kind, content: c.content }))),
      );
  } catch {
    // Ignore quota / disabled storage — losing a draft is acceptable.
  }
}

/** True when at least one cell has non-whitespace content. */
export function hasCellContent(cells: readonly { content: string }[]): boolean {
  return cells.some((c) => c.content.trim().length > 0);
}
