import { randomUUID } from 'node:crypto';
import { isMemoryEnabled, memoryPromptSection } from '@shared/ai-memory';
import type { MaskRules, MaskStyle } from '@shared/masking';
import { MCP_AUDIT_SQL_CHARS, McpChannel, type McpSetupInfo, effectiveAccess } from '@shared/mcp';
import type {
  ConnectionConfig,
  QueryResult,
  SavedConnection,
  SchemaInfo,
  Settings,
} from '@shared/protocol';
import { type BrowserWindow, Notification, app, ipcMain } from 'electron';
import { startExternalAction } from '../ai';
import { checkAddMemory, listMemory } from '../ai-memory';
import { appendAudit } from '../audit-log';
import { getDb } from '../db';
import { logger } from '../logger';
import { getSetting } from '../settings';
import { maskForMcp } from './mask';
import { type ProposalKind, ProposalStore, accessAllows } from './proposals';
import { type ScrubSsh, scrubErrorForMcp, scrubValuesFor } from './scrub';
import { McpService } from './service';
import type { McpAuditInput, McpConnectionInfo } from './tools';

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
  /** The saved connection's SSH tunnel (host, user, key path, secrets), for scrubbing only. */
  ssh(id: string): ScrubSsh | null;
  /** Values that are secret for a connection (a note may not hold them). */
  knownSecrets(id: string): string[];
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
function summon(
  win: BrowserWindow | null,
  client: string,
  connection: string,
  kind: ProposalKind,
): void {
  if (!win || win.isDestroyed()) return;
  const focused = win.isFocused();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (process.platform === 'darwin') app.focus({ steal: true });
  if (!focused && Notification.isSupported()) {
    new Notification({
      title: kind === 'change' ? `${client} wants to change data` : `${client} wants to add a note`,
      body: `Review it in Plasma (${connection}).`,
    }).show();
  }
}

export function startMcpHost(deps: McpHostDeps): {
  service: McpService;
  reapply(): Promise<void>;
  recheck(): void;
  proposals: ProposalStore;
} {
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

  /** What an error text must not carry for this connection. */
  const scrubValues = (id: string | null): string[] => {
    const cfg = id ? deps.fullConfig(id) : null;
    const attached = (cfg?.duckdb?.attachConnectionIds ?? []).map((a) => deps.fullConfig(a));
    return scrubValuesFor(cfg, id ? deps.ssh(id) : null, attached);
  };

  // Proposals outlive the server: an approved change keeps running (and its
  // outcome is kept) even if MCP is turned off meanwhile.
  const proposals = new ProposalStore({
    scrub: (id, text) => scrubErrorForMcp(text, scrubValues(id)),
    start: (input) => {
      const started = startExternalAction({
        win: deps.mainWindow(),
        client: input.client,
        connectionId: input.connectionId,
        name: input.kind === 'change' ? 'propose_change' : 'remember',
        args: input.args,
      });
      // Only now that the card is really shown: bring Plasma forward.
      if (started.ok) summon(deps.mainWindow(), input.client, input.connectionName, input.kind);
      return started;
    },
  });

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
        return maskForMcp(columns, rows, {
          unmasked: deps.settings().connectionMcpUnmasked?.[id] === true,
          style: getSetting<MaskStyle>('maskStyle', 'initial'),
          rules: getSetting<Record<string, MaskRules>>('maskRules', {})[id],
        });
      },
      proposals: {
        create: (input) => proposals.create(input),
        wait: (id, ms, signal) => proposals.wait(id, ms, signal),
      },
      memory(id) {
        const settings = deps.settings();
        if (!isMemoryEnabled(id, settings)) return { state: 'off' };
        const section = memoryPromptSection(listMemory(getDb(), id));
        return section ? { state: 'on', text: section.text } : { state: 'empty' };
      },
      checkRemember(id, text) {
        const r = checkAddMemory(getDb(), id, text, deps.knownSecrets(id));
        return r.ok ? null : r.error;
      },
      scrub(id, text) {
        return scrubErrorForMcp(text, scrubValues(id));
      },
      now: () => Date.now(),
    },
  });

  const apply = () => {
    const s = deps.settings();
    const enabled = s.mcpEnabled === true;
    // Turning MCP off takes back what nobody decided yet; an approved run goes on.
    if (!enabled) proposals.withdrawUndecided('Withdrawn: the MCP server was turned off.');
    return service.apply({ enabled, port: s.mcpPort });
  };

  /** Access lowered, memory turned off or the connection deleted: take back what is still undecided. */
  const recheck = () => {
    const s = deps.settings();
    const byId = new Map(deps.connections().map((c) => [c.id, c]));
    proposals.recheck((id, kind) => {
      const c = byId.get(id);
      if (!c) return 'Withdrawn: the connection was deleted.';
      const access = effectiveAccess(s.connectionMcpAccess?.[id], c.readOnly === true);
      if (!accessAllows(access, kind))
        return 'Withdrawn: AI tool access to this connection was lowered.';
      if (kind === 'remember' && !isMemoryEnabled(id, s))
        return 'Withdrawn: notes were turned off.';
      return null;
    });
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
  return { service, reapply: apply, recheck, proposals };
}
