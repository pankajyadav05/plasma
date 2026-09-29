import type { ActivityRow } from '@shared/protocol';

/** Application names Plasma's own worker connections use. */
const PLASMA_APPS = new Set(['plasma', 'plasma-control', 'plasma-aux']);

/** True for sessions opened by Plasma (its editor, control and sideband connections). */
export function isPlasmaSession(r: Pick<ActivityRow, 'applicationName'>): boolean {
  return PLASMA_APPS.has((r.applicationName ?? '').toLowerCase());
}

export interface ActivityFilter {
  showIdle: boolean;
  /** Include the monitor's own polling backend. */
  showSelf: boolean;
  /** Case-insensitive match on query, user, application, client or pid. */
  search: string;
  /** Only this database; null = all. */
  database: string | null;
}

export function filterActivity(rows: readonly ActivityRow[], f: ActivityFilter): ActivityRow[] {
  const q = f.search.trim().toLowerCase();
  return rows.filter((r) => {
    if (!f.showSelf && r.isCurrent) return false;
    if (!f.showIdle && r.state === 'idle') return false;
    if (f.database && r.database !== f.database) return false;
    if (!q) return true;
    return [r.query, r.user, r.applicationName, r.clientAddr, String(r.pid)].some((v) =>
      (v ?? '').toLowerCase().includes(q),
    );
  });
}

/**
 * pg_cancel_backend / pg_terminate_backend return `false` (not an error)
 * when the signal wasn't sent — the result must be checked (H3).
 */
export function killSucceeded(rows: readonly unknown[][]): boolean {
  const v = rows[0]?.[0];
  return v === true || v === 't' || v === 'true' || v === 1;
}
