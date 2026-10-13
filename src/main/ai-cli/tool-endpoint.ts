import { createHash, randomBytes } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import {
  type McpHandler,
  type McpToolDef,
  RPC,
  createMcpHandler,
  isSupportedVersion,
  rpcError,
  textResult,
} from '../mcp/protocol';
import { bearerToken, header, hostAllowed, readBody, send } from '../mcp/server';

/**
 * The tools of a CLI-driven chat (Codex, Claude Code), served to the CLI as an
 * MCP server on 127.0.0.1. One HTTP server for every running chat; each chat
 * registers a random token that maps to its own tool set and its own call
 * function. The user's own MCP server (its port and token) is never involved.
 *
 * Same door rules as the user-facing MCP server: literal loopback Host, no
 * Origin, a bearer token checked before the body is read.
 */

export interface EndpointRun {
  /** Exactly the tools the chat offers (everything else is unknown to the CLI). */
  tools: McpToolDef[];
  /** Runs one tool call; resolves with the text the model sees. Never rejects. */
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
}

export interface Registration {
  url: string;
  token: string;
  /** Stop answering for this chat: later calls get 401, running ones are aborted. */
  revoke(): void;
}

export interface ToolEndpoint {
  register(run: EndpointRun): Promise<Registration>;
  /** Chats currently registered. */
  size(): number;
  close(): Promise<void>;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function createToolEndpoint(opts: { version?: string } = {}): ToolEndpoint {
  const runs = new Map<string, McpHandler>();
  let server: Server | null = null;
  let starting: Promise<number> | null = null;
  let port = 0;

  async function onRequest(req: IncomingMessage, res: ServerResponse) {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/mcp') return send(res, 404);
    if (!hostAllowed(header(req, 'host'), port))
      return send(res, 403, rpcError(null, RPC.invalidRequest, 'Forbidden host.'));
    if (req.headers.origin !== undefined)
      return send(res, 403, rpcError(null, RPC.invalidRequest, 'Forbidden origin.'));
    const presented = bearerToken(header(req, 'authorization'));
    const handler = presented === null ? undefined : runs.get(sha(presented));
    if (!handler) {
      return send(res, 401, rpcError(null, RPC.invalidRequest, 'Missing or wrong token.'), {
        'WWW-Authenticate': 'Bearer realm="plasma"',
      });
    }
    if (req.method !== 'POST') return send(res, 405, undefined, { Allow: 'POST' });
    const type = (header(req, 'content-type') ?? '').split(';')[0]?.trim().toLowerCase();
    if (type !== 'application/json')
      return send(res, 415, rpcError(null, RPC.invalidRequest, 'Send application/json.'));
    const version = header(req, 'mcp-protocol-version') ?? null;
    if (version !== null && !isSupportedVersion(version))
      return send(
        res,
        400,
        rpcError(null, RPC.invalidRequest, 'Unsupported MCP-Protocol-Version.'),
      );
    const body = await readBody(req);
    if (!body.ok) return send(res, body.status, rpcError(null, RPC.invalidRequest, 'Bad request.'));
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.text);
    } catch {
      return send(res, 400, rpcError(null, RPC.parse, 'Parse error.'));
    }
    const gone = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) gone.abort();
    });
    const outcome = await handler.handle(parsed, {
      protocolVersion: version,
      sessionId: header(req, 'mcp-session-id') ?? null,
      signal: gone.signal,
    });
    send(
      res,
      outcome.status,
      outcome.body,
      outcome.sessionId ? { 'Mcp-Session-Id': outcome.sessionId } : {},
    );
  }

  function ensure(): Promise<number> {
    if (server && port) return Promise.resolve(port);
    starting ??= new Promise<number>((resolve, reject) => {
      const s = createServer((req, res) => {
        onRequest(req, res).catch(() => {
          if (!res.headersSent) send(res, 500, rpcError(null, RPC.internal, 'Internal error.'));
          else res.destroy();
        });
      });
      s.headersTimeout = 10_000;
      // A tool call may wait minutes for the user's click: no overall request timeout.
      s.requestTimeout = 0;
      s.maxHeadersCount = 50;
      s.once('error', (e) => {
        starting = null;
        reject(e);
      });
      // 127.0.0.1 only: never a wildcard address.
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        server = s;
        resolve(port);
      });
    });
    return starting;
  }

  async function shutdown(): Promise<void> {
    const s = server;
    server = null;
    starting = null;
    port = 0;
    if (!s) return;
    await new Promise<void>((resolve) => {
      s.close(() => resolve());
      s.closeAllConnections();
    });
  }

  return {
    async register(run) {
      const p = await ensure();
      const token = randomBytes(32).toString('base64url');
      let chain: Promise<void> = Promise.resolve();
      const handler = createMcpHandler({
        version: opts.version ?? '0',
        instructions: 'Plasma database tools for this chat.',
        tools: () => run.tools,
        callTool: async (name, args, ctx) => {
          // One call at a time, in arrival order, like pump (a Codex script may fire several).
          const turn = chain.then(() => run.call(name, args, ctx.signal));
          chain = turn.then(
            () => undefined,
            () => undefined,
          );
          const text = await turn;
          return textResult(text, text.startsWith('{"error":'));
        },
        maxInFlight: 8,
      });
      const key = sha(token);
      runs.set(key, handler);
      return {
        url: `http://127.0.0.1:${p}/mcp`,
        token,
        revoke() {
          const h = runs.get(key);
          if (!h) return;
          runs.delete(key);
          h.abortAll();
          if (runs.size === 0) void shutdown();
        },
      };
    },
    size: () => runs.size,
    close: async () => {
      for (const h of runs.values()) h.abortAll();
      runs.clear();
      await shutdown();
    },
  };
}

/** The OpenAI-style function specs `pump` offers, as MCP tool definitions. */
export function mcpToolsFromOpenAi(tools: readonly unknown[]): McpToolDef[] {
  return (
    tools as ReadonlyArray<{
      function: { name: string; description: string; parameters: Record<string, unknown> };
    }>
  ).map((t) => ({
    name: t.function.name,
    title: t.function.name,
    description: t.function.description,
    inputSchema: t.function.parameters,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  }));
}
