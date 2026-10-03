/**
 * Shared shapes for the Health advisor. Every check is a pure pair: the
 * SQL (or request) to run, and an interpreter that turns the returned
 * rows into findings. Nothing here touches IPC, so fixtures can drive it.
 */

export type HealthStatus = 'ok' | 'warn' | 'crit' | 'unknown';

/** A fix the user can preview and run through the prod gate. Never auto-run. */
export interface HealthAction {
  label: string;
  /** Preview SQL for Postgres fixes. */
  sql?: string;
  /** Free-text advice when no SQL applies (Redis, OpenSearch). */
  note?: string;
  /** Marks fixes that drop data or terminate work. */
  destructive?: boolean;
}

export interface HealthFinding {
  id: string;
  status: HealthStatus;
  title: string;
  /** The numbers behind the verdict. */
  evidence: string;
  action?: HealthAction;
}

export interface HealthColumn {
  key: string;
  label: string;
  align?: 'left' | 'right';
  width?: number;
}

export interface HealthTable {
  columns: HealthColumn[];
  rows: Array<Record<string, unknown>>;
}

export interface CheckResult {
  status: HealthStatus;
  /** One-line verdict shown on the overview tile. */
  summary: string;
  findings: HealthFinding[];
  table?: HealthTable;
  /** Shown under the section when the numbers are statistical. */
  note?: string;
}

export type Row = Record<string, unknown>;

export const STATUS_ORDER: Record<HealthStatus, number> = { ok: 0, unknown: 1, warn: 2, crit: 3 };

export function worstStatus(list: readonly HealthStatus[]): HealthStatus {
  let worst: HealthStatus = 'ok';
  for (const s of list) if (STATUS_ORDER[s] > STATUS_ORDER[worst]) worst = s;
  return worst;
}

export function num(v: unknown, fallback = 0): number {
  if (v === null || v === undefined || v === '') return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function str(v: unknown, fallback = ''): string {
  return v === null || v === undefined ? fallback : String(v);
}

export function bool(v: unknown): boolean {
  return v === true || v === 't' || v === 'true' || v === 1 || v === '1';
}

export function fmtBytes(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1024) return `${Math.round(n)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let v = n / 1024;
  let i = 0;
  while (Math.abs(v) >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function fmtDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)} min`;
  const h = m / 60;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} d`;
}

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function fmtPct(n: number, digits = 1): string {
  return `${n.toFixed(digits)}%`;
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function qualified(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

/** Turn a driver result (`columns` + array rows) into keyed objects. */
export function rowsToObjects(res: {
  columns: ReadonlyArray<{ name: string }>;
  rows: ReadonlyArray<ReadonlyArray<unknown>>;
}): Row[] {
  const names = res.columns.map((c) => c.name);
  return res.rows.map((r) => {
    const o: Row = {};
    names.forEach((n, i) => {
      o[n] = r[i];
    });
    return o;
  });
}

export type HealthErrorKind = 'privilege' | 'missing' | 'timeout' | 'other';

export interface ClassifiedHealthError {
  kind: HealthErrorKind;
  /** Short badge text, e.g. "needs pg_monitor". */
  badge: string;
  message: string;
}

/**
 * Map a Postgres / Redis / OpenSearch error message onto a friendly
 * "you lack X" or "X is not installed" state, so one forbidden view
 * degrades to a hint instead of an error banner.
 */
export function classifyHealthError(message: string): ClassifiedHealthError {
  const m = message.trim();
  if (
    /permission denied|must be (superuser|owner|member)|insufficient privilege|not allowed to/i.test(
      m,
    )
  ) {
    return { kind: 'privilege', badge: 'needs pg_monitor', message: m };
  }
  if (/NOPERM|no permissions|unauthorized|security_exception|forbidden|\b403\b/i.test(m)) {
    return { kind: 'privilege', badge: 'needs permission', message: m };
  }
  if (/pg_stat_statements must be loaded|shared_preload_libraries/i.test(m)) {
    return { kind: 'missing', badge: 'pg_stat_statements not loaded', message: m };
  }
  if (/does not exist|unknown command|ERR unknown|no such|not found|\b404\b/i.test(m)) {
    return { kind: 'missing', badge: 'unavailable', message: m };
  }
  if (/statement timeout|canceling statement|timed out|timeout/i.test(m)) {
    return { kind: 'timeout', badge: 'timed out', message: m };
  }
  return { kind: 'other', badge: 'failed', message: m };
}

export function unknownResult(err: ClassifiedHealthError): CheckResult {
  return {
    status: 'unknown',
    summary: err.badge,
    findings: [
      {
        id: 'unavailable',
        status: 'unknown',
        title: err.badge.charAt(0).toUpperCase() + err.badge.slice(1),
        evidence: err.message,
      },
    ],
  };
}

export type PgSection = 'overview' | 'indexes' | 'maintenance' | 'queries';

/** One Postgres check: read-only SQL plus the interpreter for its rows. */
export interface PgCheck {
  id: string;
  section: PgSection;
  title: string;
  sql: string;
  params?: unknown[];
  /** Statement timeout for the sideband call. */
  timeoutMs?: number;
  interpret(rows: Row[]): CheckResult;
}
