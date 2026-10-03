import type { AuditListOpts } from '@shared/audit';

export interface AuditFilterDraft {
  /** '' = every connection. */
  connectionId: string;
  /** `YYYY-MM-DD` from an `<input type="date">`, local time, or ''. */
  fromDate: string;
  toDate: string;
  outcome: 'all' | 'ok' | 'error';
  text: string;
}

export const EMPTY_AUDIT_FILTER: AuditFilterDraft = {
  connectionId: '',
  fromDate: '',
  toDate: '',
  outcome: 'all',
  text: '',
};

function localDayStart(day: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return undefined;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0).getTime();
  return Number.isFinite(t) ? t : undefined;
}

/** The IPC filter for the draft: `to` covers the whole of its day. */
export function auditFilterOf(d: AuditFilterDraft): Omit<AuditListOpts, 'limit' | 'offset'> {
  const from = localDayStart(d.fromDate);
  const toStart = localDayStart(d.toDate);
  return {
    connectionId: d.connectionId || undefined,
    from,
    to: toStart === undefined ? undefined : toStart + 86_400_000 - 1,
    outcome: d.outcome === 'all' ? undefined : d.outcome,
    text: d.text.trim() || undefined,
  };
}
