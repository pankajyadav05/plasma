import { z } from 'zod';

/**
 * Plasma MCP server: the pure parts (tested without Electron or a socket).
 * Access levels, connection lookup, text scrubbing, the numbers every layer
 * agrees on, the renderer-facing API and the setup snippets Settings shows.
 */

export const MCP_DEFAULT_PORT = 47321;
export const MCP_MIN_PORT = 1024;
export const MCP_MAX_PORT = 65535;
/** Newest first: the first entry is what we answer with when the client's is unknown. */
export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
export const MCP_MAX_BODY_BYTES = 1_000_000;
export const MCP_MAX_CALLS_IN_FLIGHT = 4;
export const MCP_DEFAULT_ROWS = 200;
export const MCP_MAX_ROWS = 1_000;
export const MCP_QUERY_TIMEOUT_MS = 30_000;
export const MCP_PROPOSE_TIMEOUT_MS = 10 * 60_000;
export const MCP_SCHEMA_CACHE_MS = 60_000;
export const MCP_ACTIVITY_LIMIT = 50;
export const MCP_AUDIT_SQL_CHARS = 2_000;

/** What an external AI tool may do on one connection. */
export const McpAccess = z.enum(['off', 'schema', 'read', 'propose']);
export type McpAccess = z.infer<typeof McpAccess>;

const RANK: Record<McpAccess, number> = { off: 0, schema: 1, read: 2, propose: 3 };

export function accessAtLeast(have: McpAccess, need: McpAccess): boolean {
  return RANK[have] >= RANK[need];
}

/** A read-only connection can never be proposed to: `propose` counts as `read`. */
export function effectiveAccess(access: McpAccess | undefined, readOnly: boolean): McpAccess {
  const a = access ?? 'off';
  return a === 'propose' && readOnly ? 'read' : a;
}

/** A usable port, or null. */
export function parseMcpPort(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n)) return null;
  return n >= MCP_MIN_PORT && n <= MCP_MAX_PORT ? n : null;
}

export type ConnectionRef = { id: string; name: string };

/** `ref` is a connection id or its exact name. Ids win; a name shared by several connections is refused. */
export function resolveConnectionRef(
  ref: unknown,
  list: readonly ConnectionRef[],
): { ok: true; id: string } | { ok: false; error: string } {
  if (typeof ref !== 'string' || ref.trim() === '') {
    return {
      ok: false,
      error: 'connection is required: pass an id or name from list_connections.',
    };
  }
  const wanted = ref.trim();
  const byId = list.find((c) => c.id === wanted);
  if (byId) return { ok: true, id: byId.id };
  const byName = list.filter((c) => c.name === wanted);
  if (byName.length === 1 && byName[0]) return { ok: true, id: byName[0].id };
  if (byName.length > 1) {
    return {
      ok: false,
      error: `More than one connection is named "${wanted}". Use an id: ${byName.map((c) => c.id).join(', ')}.`,
    };
  }
  return {
    ok: false,
    error: `No connection "${wanted}" is available to AI tools. Call list_connections.`,
  };
}

/**
 * Remove the things an error message must not carry to an MCP client: the
 * connection's host, user, password and database path. Longest first so a
 * path is replaced before the host inside it.
 */
export function scrubKnown(
  text: string,
  secrets: ReadonlyArray<string | undefined | null>,
): string {
  const parts = secrets
    .filter((s): s is string => typeof s === 'string' && s.length >= 3)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const s of parts) out = out.split(s).join('…');
  return out;
}

/** The client name for logs and cards: short, one line, no markup. */
export function cleanClientName(raw: unknown): string {
  if (typeof raw !== 'string') return 'An AI tool';
  const t = raw
    .replace(/[\p{Cc}<>]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return t || 'An AI tool';
}

export type McpOutcome = 'ok' | 'error' | 'declined' | 'denied';

export interface McpActivityEntry {
  /** Epoch ms. */
  ts: number;
  client: string;
  tool: string;
  connectionName: string | null;
  outcome: McpOutcome;
}

export type McpListenState = 'off' | 'listening' | 'port-in-use' | 'error';

export interface McpStatus {
  enabled: boolean;
  port: number;
  state: McpListenState;
  /** Plain-words status line for Settings. */
  message: string;
  activity: McpActivityEntry[];
}

export const McpChannel = {
  Status: 'plasma:mcp:status',
  Token: 'plasma:mcp:token',
  RegenerateToken: 'plasma:mcp:regenerate-token',
  Setup: 'plasma:mcp:setup',
} as const;

/** How to start the stdio bridge on this machine, for the Claude Desktop snippet. */
export interface McpSetupInfo {
  platform: 'darwin' | 'win32' | 'linux';
  /** The `plasma` launcher if installed, else the app binary. */
  command: string;
  args: string[];
  /** Extra environment the command needs (only for a non-default profile). */
  env: Record<string, string>;
  /** Whether `command` is the installed `plasma` launcher. */
  launcherInstalled: boolean;
}

export interface McpApi {
  status(): Promise<McpStatus>;
  /** The bearer token. Only the Settings screen asks for it. */
  token(): Promise<string>;
  /** New token; clients using the old one stop working. */
  regenerateToken(): Promise<string>;
  setup(): Promise<McpSetupInfo>;
}

export interface McpSnippetInput {
  port: number;
  token: string;
  setup: McpSetupInfo;
}

export function mcpUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

export function claudeCodeSnippet({ port, token }: McpSnippetInput): string {
  return `claude mcp add --transport http plasma ${mcpUrl(port)} --header "Authorization: Bearer ${token}"`;
}

export function cursorSnippet({ port, token }: McpSnippetInput): string {
  return JSON.stringify(
    {
      mcpServers: { plasma: { url: mcpUrl(port), headers: { Authorization: `Bearer ${token}` } } },
    },
    null,
    2,
  );
}

export function codexSnippet({ port, token }: McpSnippetInput): string {
  return [
    '[mcp_servers.plasma]',
    `url = "${mcpUrl(port)}"`,
    `http_headers = { "Authorization" = "Bearer ${token}" }`,
  ].join('\n');
}

export function stdioSnippet({ setup }: McpSnippetInput): string {
  const entry: Record<string, unknown> = { command: setup.command, args: setup.args };
  if (Object.keys(setup.env).length > 0) entry.env = setup.env;
  return JSON.stringify({ mcpServers: { plasma: entry } }, null, 2);
}

/** The token as shown while hidden. */
export function maskToken(token: string): string {
  return token ? '•'.repeat(24) : '';
}
