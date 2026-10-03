/**
 * Remembers which SQL an AI suggestion put into which tab, so the audit log
 * can tell "AI suggestion applied" from hand-written SQL when it is run.
 * Whitespace-insensitive; a statement counts when it appears in the applied text.
 */
const applied = new Map<string, string>();

const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim().replace(/;$/, '').toLowerCase();

export function markAiApplied(tabId: string | undefined, sql: string): void {
  if (!tabId || !sql.trim()) return;
  // Keep earlier suggestions of the same tab: a script may mix several.
  applied.set(tabId, `${applied.get(tabId) ?? ''} ${norm(sql)}`.trim());
}

export function isAiApplied(tabId: string, statement: string): boolean {
  const text = applied.get(tabId);
  const stmt = norm(statement);
  return Boolean(text && stmt && text.includes(stmt));
}

export function forgetAiApplied(tabId: string): void {
  applied.delete(tabId);
}
