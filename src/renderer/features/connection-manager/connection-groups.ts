/** C28: saved connections listed under optional folders. */

export interface ConnectionGroup<T> {
  /** Folder name, or null for connections without one. */
  group: string | null;
  items: T[];
}

/** Folder names are compared case-insensitively and trimmed. */
export function normaliseGroup(name: string | undefined | null): string | null {
  const t = (name ?? '').trim();
  return t ? t : null;
}

/**
 * Split connections into the ungrouped ones (first) and one entry per folder,
 * folders sorted by name. Input order is kept inside each group, so the
 * vault's most-recently-used ordering survives.
 */
export function groupConnections<T extends { group?: string }>(
  list: readonly T[],
): ConnectionGroup<T>[] {
  const ungrouped: T[] = [];
  const byKey = new Map<string, { label: string; items: T[] }>();
  for (const c of list) {
    const g = normaliseGroup(c.group);
    if (!g) {
      ungrouped.push(c);
      continue;
    }
    const key = g.toLowerCase();
    const entry = byKey.get(key) ?? { label: g, items: [] };
    entry.items.push(c);
    byKey.set(key, entry);
  }
  const groups = [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
  return [
    ...(ungrouped.length > 0 ? [{ group: null, items: ungrouped }] : []),
    ...groups.map((g) => ({ group: g.label, items: g.items })),
  ];
}

/** Distinct folder names in use, for the dialog's suggestions. */
export function existingGroups(list: readonly { group?: string }[]): string[] {
  const seen = new Map<string, string>();
  for (const c of list) {
    const g = normaliseGroup(c.group);
    if (g && !seen.has(g.toLowerCase())) seen.set(g.toLowerCase(), g);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}
