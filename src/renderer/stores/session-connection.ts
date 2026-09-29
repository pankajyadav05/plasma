/**
 * Connection-lifecycle helpers for the session store (B2 / C15 / C21 / G2).
 * Kept out of session.ts so they can be unit-tested without the store.
 */

/**
 * State that belongs to one server session and must not leak into the
 * next one (B2): schema tree, search_path pick, SET ROLE, role list,
 * per-engine overviews and bulk selections.
 */
export function freshSessionPatch() {
  return {
    schema: null,
    expandedSchemas: new Set<string>(),
    currentSchema: null,
    activeTable: null,
    activeRole: null,
    availableRoles: [] as string[],
    roleError: null,
    txnState: 'none' as const,
    redisOverview: null,
    redisKeys: null,
    redisMatch: null,
    osOverview: null,
    activeRedisKey: null,
    activeOsIndex: null,
    redisBulkMode: false,
    selectedRedisKeys: new Set<string>(),
  };
}

/** `SET ROLE "<name>"` with the identifier quoted. */
export function setRoleSql(role: string): string {
  return `SET ROLE "${role.replace(/"/g, '""')}"`;
}

/** Error text without Electron's "Error invoking remote method …" wrapper. */
export function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+':\s*/i, '').replace(/^Error:\s*/i, '');
}
