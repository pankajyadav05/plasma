import { randomUUID } from 'node:crypto';
import { type MaskRules, type MaskStyle, maskResultRows } from '@shared/masking';
import {
  MCP_AUDIT_SQL_CHARS,
  MCP_PROPOSE_TIMEOUT_MS,
  McpChannel,
  type McpSetupInfo,
  effectiveAccess,
  scrubKnown,
} from '@shared/mcp';
import type {
  ConnectionConfig,
  QueryResult,
  SavedConnection,
  SchemaInfo,
  Settings,
} from '@shared/protocol';
import { type BrowserWindow, Notification, app, ipcMain } from 'electron';
import { requestExternalChange } from '../ai';
import { appendAudit } from '../audit-log';
import { getDb } from '../db';
import { logger } from '../logger';
import { redactErrorText } from '../redact';
import { getSetting } from '../settings';
import { McpService } from './service';
import type { McpAuditInput, McpConnectionInfo, ProposeOutcome } from './tools';

/**
 * Electron-side wiring of the MCP server: the numbers Plasma knows (saved
 * connections, settings, the open connection), the isolated read session,
 * the approval round-trip, the audit log and the Settings IPC.
 */

export interface McpHostDeps {
  userDataDir: string;
  version: string;
  connections(): SavedConnection[];
  fullConfig(id: string): ConnectionConfig | null;
  settings(): Settings;
  /** The connection open in Plasma right now (SQL engines only), or null. */
  openConnectionId(): string | null;
  mainWindow(): BrowserWindow | null;
  runIsolatedRead(
    id: string,
    sql: string,
    maxRows: number,
    opts: { runId: string; timeoutMs: number },
  ): Promise<QueryResult>;
  cancelIsolatedRun(runId: string): Promise<void>;
  introspectIsolated(id: string): Promise<SchemaInfo>;
  /** Where the installed `plasma` launcher is, or null. */
  installedLauncher(): string | null;
}

/** Bring Plasma forward; an OS notification when it was not already focused. */
function summon(win: BrowserWindow | null, client: string, connection: string): void {
  if (!win || win.isDestroyed()) return;
  const focused = win.isFocused();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (process.platform === 'darwin') app.focus({ steal: true });
  if (!focused && Notification.isSupported()) {
    new Notification({
      title: `${client} wants to change data`,
      body: `Review it in Plasma (${connection}).`,
    }).show();
  }
}

function affectedFrom(res: { note?: string; data?: { rowCount: number } }): number | undefined {
  const m = /(\d+)\s+rows?\b/.exec(res.note ?? '');
  if (m?.[1]) return Number(m[1]);
  return res.data?.rowCount;
}

export function startMcpHost(deps: McpHostDeps): { service: McpService; reapply(): Promise<void> } {
  const info = (c: SavedConnection, s: Settings): McpConnectionInfo => {
    const readOnly = c.readOnly === true;
    return {
      id: c.id,
      name: c.name,
      engine: c.engine ?? 'postgres',
      readOnly,
      production: s.connectionTags?.[c.id] === 'prod',
      access: effectiveAccess(s.connectionMcpAccess?.[c.id], readOnly),
      unmasked: s.connectionMcpUnmasked?.[c.id] === true,
      openInPlasma: deps.openConnectionId() === c.id,
    };
  };

  const service = new McpService({
    userDataDir: deps.userDataDir,
    version: deps.version,
    log: (m) => logger.warn(`[plasma] mcp: ${m}`),
    audit: (e: McpAuditInput) => {
      try {
        appendAudit(getDb(), {
          connectionId: e.connectionId,
          connectionName: e.connectionName,
          // The database user never goes into MCP records.
          dbUser: '',
          statement: `-- MCP: ${e.client} / ${e.tool}\n${e.sql.slice(0, MCP_AUDIT_SQL_CHARS)}`,
          error: e.outcome === 'ok' ? null : (e.error ?? e.outcome),
          affectedRows: e.rows,
          durationMs: e.durationMs,
          source: 'mcp',
        });
      } catch (err) {
        logger.error('[plasma] mcp audit write failed (non-fatal):', err);
      }
    },
    tools: {
      connections: () => {
        const s = deps.settings();
        return deps.connections().map((c) => info(c, s));
      },
      async runRead(id, sql, maxRows, signal) {
        const runId = randomUUID();
        const stop = () => void deps.cancelIsolatedRun(runId).catch(() => undefined);
        signal.addEventListener('abort', stop, { once: true });
        try {
          return await deps.runIsolatedRead(id, sql, maxRows, { runId, timeoutMs: 30_000 });
        } finally {
          signal.removeEventListener('abort', stop);
        }
      },
      schema: (id) => deps.introspectIsolated(id),
      maskRows(id, columns, rows) {
        if (deps.settings().connectionMcpUnmasked?.[id] === true) return rows;
        // Always on for MCP, whatever presentation mode says.
        const style = getSetting<MaskStyle>('maskStyle', 'initial');
        const rules = getSetting<Record<string, MaskRules>>('maskRules', {})[id];
        return maskResultRows(columns, rows, { style, rules });
      },
      async propose(input): Promise<ProposeOutcome> {
        summon(deps.mainWindow(), input.client, input.connectionName);
        const r = await requestExternalChange({
          win: deps.mainWindow(),
          client: input.client,
          connectionId: input.connectionId,
          sql: input.sql,
          summary: input.summary,
          signal: input.signal,
          timeoutMs: MCP_PROPOSE_TIMEOUT_MS,
        });
        switch (r.kind) {
          case 'refused':
            return { kind: 'busy', note: r.note };
          case 'timeout':
            return { kind: 'timeout' };
          case 'cancelled':
            return { kind: 'declined', note: 'Cancelled. Nothing was changed.' };
        }
        const res = r.res;
        switch (res.outcome) {
          case 'applied': {
            const rows = affectedFrom(res);
            return {
              kind: 'applied',
              note: res.note?.slice(0, 300),
              ...(rows !== undefined ? { rowsAffected: rows } : {}),
            };
          }
          case 'rejected':
            return {
              kind: 'declined',
              note: res.note
                ? `The user declined: ${res.note.slice(0, 300)}`
                : 'The user declined. Nothing was changed.',
            };
          case 'failed': {
            const text = res.dbError ?? res.note ?? 'The change failed.';
            return {
              kind: 'failed',
              note: (redactErrorText(text).split('\n')[0] ?? '').slice(0, 400),
            };
          }
          default:
            return {
              kind: 'failed',
              note:
                res.note?.slice(0, 300) ?? 'Stopped before the statement finished. Check the data.',
            };
        }
      },
      scrub(id, text) {
        const cfg = id ? deps.fullConfig(id) : null;
        const db = cfg?.database && /[\\/]/.test(cfg.database) ? cfg.database : null;
        return redactErrorText(scrubKnown(text, [cfg?.password, cfg?.host, cfg?.user, db]));
      },
      now: () => Date.now(),
    },
  });

  const apply = () => {
    const s = deps.settings();
    return service.apply({ enabled: s.mcpEnabled === true, port: s.mcpPort });
  };

  ipcMain.handle(McpChannel.Status, async () => {
    return service.status();
  });
  ipcMain.handle(McpChannel.Token, () => service.getToken());
  ipcMain.handle(McpChannel.RegenerateToken, () => service.rotateToken());
  ipcMain.handle(McpChannel.Setup, (): McpSetupInfo => {
    const launcher = deps.installedLauncher();
    const env: Record<string, string> = process.env.PLASMA_USER_DATA
      ? { PLASMA_USER_DATA: process.env.PLASMA_USER_DATA }
      : {};
    return {
      platform: process.platform as McpSetupInfo['platform'],
      command: launcher ?? process.env.APPIMAGE ?? process.execPath,
      args: launcher ? ['mcp'] : ['--plasma-mcp-bridge'],
      env,
      launcherInstalled: launcher !== null,
    };
  });

  void apply();
  // Settings changes call `reapply` (port / enable switch); cheap when nothing changed.
  return { service, reapply: apply };
}
