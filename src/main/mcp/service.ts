import {
  MCP_ACTIVITY_LIMIT,
  type McpActivityEntry,
  type McpListenState,
  type McpStatus,
} from '@shared/mcp';
import { createMcpHandler } from './protocol';
import { type McpHttpServer, createMcpHttpServer } from './server';
import { loadOrCreateToken, regenerateToken, removePortFile, writePortFile } from './token-store';
import { MCP_INSTRUCTIONS, type McpAuditInput, type McpToolsDeps, createMcpTools } from './tools';

/**
 * Lifecycle of the MCP server: listens only while enabled, restarts on a
 * port or token change, keeps the last 50 calls in memory for Settings.
 */

export interface McpServiceOptions {
  userDataDir: string;
  version: string;
  tools: Omit<McpToolsDeps, 'audit'>;
  /** Writes the audit log entry for a call. */
  audit: (entry: McpAuditInput) => void;
  log?: (message: string) => void;
}

export class McpService {
  private http: McpHttpServer | null = null;
  private token = '';
  private enabled = false;
  private port = 0;
  private state: McpListenState = 'off';
  private message = 'Off';
  private readonly activity: McpActivityEntry[] = [];
  private tools: ReturnType<typeof createMcpTools> | null = null;
  /** Serializes apply() calls so a quick toggle never races two listens. */
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly opts: McpServiceOptions) {}

  /** Make the running state match the settings. Safe to call often. */
  apply(settings: { enabled: boolean; port: number }): Promise<void> {
    this.chain = this.chain.then(() => this.applyNow(settings)).catch(() => undefined);
    return this.chain;
  }

  private async applyNow(settings: { enabled: boolean; port: number }): Promise<void> {
    const same = this.http !== null && settings.enabled && settings.port === this.port;
    this.enabled = settings.enabled;
    if (same) return;
    await this.stopNow();
    this.port = settings.port;
    if (!settings.enabled) {
      this.state = 'off';
      this.message = 'Off';
      return;
    }
    try {
      this.token = loadOrCreateToken(this.opts.userDataDir);
    } catch (err) {
      this.fail('error', 'Could not save the token file.', err);
      return;
    }
    const tools = createMcpTools({
      ...this.opts.tools,
      audit: (e) => {
        this.record(e);
        this.opts.audit(e);
      },
    });
    this.tools = tools;
    const handler = createMcpHandler({
      version: this.opts.version,
      instructions: MCP_INSTRUCTIONS,
      tools: tools.defs,
      callTool: (name, args, ctx) => tools.call(name, args, ctx),
      log: this.opts.log,
    });
    const http = createMcpHttpServer({ handler, token: () => this.token, log: this.opts.log });
    try {
      const bound = await http.listen(settings.port);
      this.http = http;
      this.port = bound;
      writePortFile(this.opts.userDataDir, bound);
      this.state = 'listening';
      this.message = `Listening on 127.0.0.1:${bound}`;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'EADDRINUSE') {
        this.fail('port-in-use', `Port ${settings.port} is in use by another app`, err);
      } else {
        this.fail('error', `Could not listen on port ${settings.port}`, err);
      }
    }
  }

  private fail(state: McpListenState, message: string, err: unknown): void {
    this.state = state;
    this.message = message;
    this.opts.log?.(`${message}: ${err instanceof Error ? err.message : String(err)}`);
  }

  private async stopNow(): Promise<void> {
    const http = this.http;
    this.http = null;
    this.tools?.clearCache();
    this.tools = null;
    removePortFile(this.opts.userDataDir);
    await http?.close();
  }

  /** Quit: close the socket and abort running calls. */
  stop(): Promise<void> {
    this.chain = this.chain.then(() => this.stopNow());
    return this.chain;
  }

  private record(e: McpAuditInput): void {
    this.activity.unshift({
      ts: Date.now(),
      client: e.client,
      tool: e.tool,
      connectionName: e.connectionName || null,
      outcome: e.outcome,
    });
    if (this.activity.length > MCP_ACTIVITY_LIMIT) this.activity.length = MCP_ACTIVITY_LIMIT;
  }

  status(): McpStatus {
    return {
      enabled: this.enabled,
      port: this.port,
      state: this.state,
      message: this.message,
      activity: [...this.activity],
    };
  }

  /** The current token (creates the file on first ask). */
  getToken(): string {
    return this.token || loadOrCreateToken(this.opts.userDataDir);
  }

  /** New token; the running server uses it from the next request on. */
  rotateToken(): string {
    this.token = regenerateToken(this.opts.userDataDir);
    return this.token;
  }
}
