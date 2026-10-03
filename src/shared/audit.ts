import { z } from 'zod';
import { csvEscape } from './export-format';

/** Where an audited statement came from. */
export const AUDIT_SOURCES = [
  'editor',
  'grid-commit',
  'safe-run',
  'structure',
  'import',
  'ai',
  'notify',
] as const;
export const AuditSource = z.enum(AUDIT_SOURCES);
export type AuditSource = z.infer<typeof AuditSource>;

export const AUDIT_OUTCOMES = ['ok', 'error'] as const;
export const DEFAULT_AUDIT_RETENTION_DAYS = 90;
export const MAX_AUDIT_RETENTION_DAYS = 3650;

export interface AuditEntry {
  id: number;
  /** Epoch ms. */
  ts: number;
  connectionId: string | null;
  connectionName: string;
  dbUser: string;
  /** Redacted with the history redactor before it was stored. */
  statement: string;
  outcome: 'ok' | 'error';
  /** Redacted error text; null when the statement succeeded. */
  error: string | null;
  affectedRows: number | null;
  durationMs: number | null;
  source: AuditSource;
  prevHash: string;
  hash: string;
}

/** Renderer-supplied filters for the Audit tab. */
export const AuditListOpts = z.object({
  connectionId: z.string().max(200).optional(),
  from: z.number().int().nonnegative().optional(),
  to: z.number().int().nonnegative().optional(),
  outcome: z.enum(['ok', 'error']).optional(),
  text: z.string().max(500).optional(),
  limit: z.number().int().min(1).max(5000).default(500),
  offset: z.number().int().min(0).default(0),
});
export type AuditListOpts = z.input<typeof AuditListOpts>;

export const AuditExportRequest = z.object({
  format: z.enum(['csv', 'json']),
  filter: AuditListOpts.omit({ limit: true, offset: true }).default({}),
});
export type AuditExportRequest = z.infer<typeof AuditExportRequest>;

export interface AuditVerifyResult {
  ok: boolean;
  /** Rows examined. */
  checked: number;
  /** First row whose hash or link does not match, when not ok. */
  badId: number | null;
  reason: string | null;
}

export type AuditExportResult =
  | { ok: true; path: string; rows: number }
  | { ok: false; canceled: true };

const CSV_COLUMNS: Array<[string, (e: AuditEntry) => unknown]> = [
  ['id', (e) => e.id],
  ['time', (e) => new Date(e.ts).toISOString()],
  ['connection', (e) => e.connectionName],
  ['connection_id', (e) => e.connectionId],
  ['user', (e) => e.dbUser],
  ['source', (e) => e.source],
  ['outcome', (e) => e.outcome],
  ['affected_rows', (e) => e.affectedRows],
  ['duration_ms', (e) => e.durationMs],
  ['statement', (e) => e.statement],
  ['error', (e) => e.error],
  ['prev_hash', (e) => e.prevHash],
  ['hash', (e) => e.hash],
];

const CSV_OPTS = {
  delimiter: ',',
  header: true,
  quote: '"',
  nullAs: 'empty',
  lineEnding: 'lf',
} as const;

/** CSV (formula-guarded) or JSON text for an audit export. */
export function formatAuditExport(entries: readonly AuditEntry[], format: 'csv' | 'json'): string {
  if (format === 'json') return `${JSON.stringify(entries, null, 2)}\n`;
  const lines = [CSV_COLUMNS.map(([h]) => h).join(',')];
  for (const e of entries) {
    lines.push(CSV_COLUMNS.map(([, f]) => csvEscape(f(e), CSV_OPTS)).join(','));
  }
  return `${lines.join('\n')}\n`;
}
