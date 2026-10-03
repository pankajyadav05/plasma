import { writeFile } from 'node:fs/promises';
import {
  AuditExportRequest,
  type AuditExportResult,
  AuditListOpts,
  type AuditSource,
  DEFAULT_AUDIT_RETENTION_DAYS,
  formatAuditExport,
} from '@shared/audit';
import { IpcChannel } from '@shared/protocol';
import { type BrowserWindow, dialog, ipcMain } from 'electron';
import { appendAudit, listAudit, listAuditForExport, pruneAudit, verifyAudit } from './audit-log';
import { getDb } from './db';
import { logger } from './logger';
import { getSetting } from './settings';

/**
 * Wiring for the local audit log: which statements get recorded, the
 * renderer-facing IPC (list / verify / export) and the retention pass.
 * The table itself and its hash chain live in audit-log.ts.
 */

export interface AuditSession {
  id: string;
  name: string;
  user: string;
  engine?: string;
}

export interface AuditPolicy {
  connectionTags?: Record<string, string>;
  auditAllConnections?: boolean;
}

/** Prod-tagged connections are always audited; the rest only when the setting says so. */
export function shouldAudit(connectionId: string | null | undefined, policy: AuditPolicy): boolean {
  if (!connectionId) return false;
  if (policy.auditAllConnections === true) return true;
  return policy.connectionTags?.[connectionId] === 'prod';
}

export interface AuditStatement {
  sql: string;
  source: AuditSource;
  error?: string | null;
  affectedRows?: number | null;
  durationMs?: number | null;
  ts?: number;
}

export interface AuditDeps {
  session: () => AuditSession | null;
  window: () => BrowserWindow | null;
}

const SQL_ENGINES = new Set(['postgres', 'mysql', 'sqlite', 'duckdb', 'clickhouse']);

/** Append `statements` for the live session when policy says so. Never throws. */
export function recordAuditStatements(deps: AuditDeps, statements: AuditStatement[]): void {
  try {
    const session = deps.session();
    if (!session || statements.length === 0) return;
    if (session.engine && !SQL_ENGINES.has(session.engine)) return;
    const policy: AuditPolicy = {
      connectionTags: getSetting<Record<string, string>>('connectionTags', {}),
      auditAllConnections: getSetting<boolean>('auditAllConnections', false),
    };
    if (!shouldAudit(session.id, policy)) return;
    const db = getDb();
    for (const s of statements) {
      appendAudit(db, {
        connectionId: session.id,
        connectionName: session.name,
        dbUser: session.user,
        statement: s.sql,
        error: s.error ?? null,
        affectedRows: s.affectedRows ?? null,
        durationMs: s.durationMs ?? null,
        source: s.source,
        ts: s.ts,
      });
    }
  } catch (err) {
    logger.error('[plasma] audit write failed (non-fatal):', err);
  }
}

/** Apply the retention setting; returns the rows removed. */
export function runAuditRetention(): number {
  try {
    const days = getSetting<number>('auditRetentionDays', DEFAULT_AUDIT_RETENTION_DAYS);
    return pruneAudit(getDb(), Number.isFinite(days) ? days : DEFAULT_AUDIT_RETENTION_DAYS);
  } catch (err) {
    logger.error('[plasma] audit retention failed (non-fatal):', err);
    return 0;
  }
}

export function registerAuditIpc(deps: AuditDeps): void {
  runAuditRetention();
  const timer = setInterval(runAuditRetention, 6 * 60 * 60 * 1000);
  timer.unref?.();

  ipcMain.handle(IpcChannel.AuditList, (_e, raw: unknown) => {
    return listAudit(getDb(), AuditListOpts.parse(raw ?? {}));
  });

  ipcMain.handle(IpcChannel.AuditVerify, () => verifyAudit(getDb()));

  ipcMain.handle(IpcChannel.AuditExport, async (_e, raw: unknown): Promise<AuditExportResult> => {
    const req = AuditExportRequest.parse(raw);
    const stamp = new Date().toISOString().slice(0, 10);
    const opts = {
      title: 'Export audit log',
      defaultPath: `plasma-audit-${stamp}.${req.format}`,
      filters: [{ name: req.format.toUpperCase(), extensions: [req.format] }],
    };
    const win = deps.window();
    const picked = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
    const entries = listAuditForExport(getDb(), req.filter);
    await writeFile(picked.filePath, formatAuditExport(entries, req.format), 'utf8');
    return { ok: true, path: picked.filePath, rows: entries.length };
  });
}
