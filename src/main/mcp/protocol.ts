import { randomUUID } from 'node:crypto';
import { MCP_MAX_CALLS_IN_FLIGHT, MCP_PROTOCOL_VERSIONS, cleanClientName } from '@shared/mcp';

/**
 * JSON-RPC 2.0 + the slice of MCP Plasma serves (initialize, ping,
 * tools/list, tools/call). Pure: no sockets, no Electron. server.ts does the
 * HTTP; tools.ts supplies the tools.
 *
 * Batches: revision 2025-03-26 allows them, 2025-06-18 and 2025-11-25 removed
 * them. A batch is handled only when the request's MCP-Protocol-Version is
 * 2025-03-26 (or absent, which that revision's rules assume); on a newer one
 * it is refused with -32600.
 */

export type JsonRpcId = string | number;

export const RPC = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

export interface McpToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: false;
  };
}

export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface ToolContext {
  client: string;
  signal: AbortSignal;
}

export interface McpHandlerDeps {
  version: string;
  instructions: string;
  tools: () => McpToolDef[];
  callTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<McpToolResult>;
  maxInFlight?: number;
  log?: (message: string) => void;
}

/** What the HTTP layer sends back. `body` is absent for 202. */
export interface RpcOutcome {
  status: number;
  body?: unknown;
  sessionId?: string;
}

export interface RpcContext {
  /** The MCP-Protocol-Version header, or null when absent. */
  protocolVersion: string | null;
  /** The Mcp-Session-Id header, or null. */
  sessionId: string | null;
  /** Fires when the HTTP connection drops before the answer was sent. */
  signal?: AbortSignal;
}

export const textResult = (text: string, isError = false): McpToolResult => ({
  content: [{ type: 'text', text }],
  ...(isError ? { isError: true } : {}),
});

export const rpcError = (id: JsonRpcId | null, code: number, message: string) => ({
  jsonrpc: '2.0' as const,
  id,
  error: { code, message },
});
const rpcResult = (id: JsonRpcId, result: unknown) => ({ jsonrpc: '2.0' as const, id, result });

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const isId = (v: unknown): v is JsonRpcId =>
  typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

export function isSupportedVersion(v: string): boolean {
  return (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(v);
}

/** The client's version when we speak it, else our newest. */
export function negotiateVersion(requested: unknown): string {
  return typeof requested === 'string' && isSupportedVersion(requested)
    ? requested
    : (MCP_PROTOCOL_VERSIONS[0] as string);
}

const MAX_SESSIONS = 64;

export function createMcpHandler(deps: McpHandlerDeps) {
  const sessions = new Map<string, { client: string }>();
  const running = new Map<string, AbortController>();
  const all = new AbortController();
  let inFlight = 0;
  const cap = deps.maxInFlight ?? MCP_MAX_CALLS_IN_FLIGHT;

  const clientOf = (sessionId: string | null) =>
    (sessionId ? sessions.get(sessionId)?.client : undefined) ?? 'An AI tool';

  async function callTool(
    id: JsonRpcId,
    params: unknown,
    client: string,
    sessionId: string | null,
    connection?: AbortSignal,
  ): Promise<unknown> {
    if (!isObject(params) || typeof params.name !== 'string') {
      return rpcError(id, RPC.invalidParams, 'tools/call needs a tool name.');
    }
    const name = params.name;
    if (!deps.tools().some((t) => t.name === name)) {
      return rpcError(id, RPC.invalidParams, `Unknown tool: ${name.slice(0, 80)}`);
    }
    const args = params.arguments;
    if (args !== undefined && !isObject(args)) {
      return rpcResult(id, textResult('arguments must be an object.', true));
    }
    if (inFlight >= cap) return rpcResult(id, textResult('Plasma is busy, try again.', true));
    inFlight++;
    const controller = new AbortController();
    const onAll = () => controller.abort();
    all.signal.addEventListener('abort', onAll, { once: true });
    if (connection?.aborted) controller.abort();
    else connection?.addEventListener('abort', onAll, { once: true });
    const key = `${sessionId ?? ''}:${id}`;
    running.set(key, controller);
    try {
      const result = await deps.callTool(name, args ?? {}, { client, signal: controller.signal });
      return rpcResult(id, result);
    } catch (err) {
      deps.log?.(`tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
      return rpcResult(id, textResult('That call failed inside Plasma.', true));
    } finally {
      inFlight--;
      running.delete(key);
      all.signal.removeEventListener('abort', onAll);
      connection?.removeEventListener('abort', onAll);
    }
  }

  /** One message that is a request (has an id). */
  async function request(
    msg: Record<string, unknown>,
    id: JsonRpcId,
    ctx: RpcContext,
  ): Promise<{ response: unknown; sessionId?: string }> {
    const method = msg.method as string;
    switch (method) {
      case 'initialize': {
        const params = isObject(msg.params) ? msg.params : {};
        const info = isObject(params.clientInfo) ? params.clientInfo : {};
        const client = cleanClientName(info.name);
        if (sessions.size >= MAX_SESSIONS) {
          const oldest = sessions.keys().next().value;
          if (oldest !== undefined) sessions.delete(oldest);
        }
        const sessionId = randomUUID();
        sessions.set(sessionId, { client });
        return {
          sessionId,
          response: rpcResult(id, {
            protocolVersion: negotiateVersion(params.protocolVersion),
            capabilities: { tools: {} },
            serverInfo: { name: 'plasma', title: 'Plasma', version: deps.version },
            instructions: deps.instructions,
          }),
        };
      }
      case 'ping':
        return { response: rpcResult(id, {}) };
      case 'tools/list':
        return { response: rpcResult(id, { tools: deps.tools() }) };
      case 'tools/call':
        return {
          response: await callTool(
            id,
            msg.params,
            clientOf(ctx.sessionId),
            ctx.sessionId,
            ctx.signal,
          ),
        };
      default:
        return {
          response: rpcError(id, RPC.methodNotFound, `Method not found: ${method.slice(0, 80)}`),
        };
    }
  }

  function notification(msg: Record<string, unknown>, ctx: RpcContext): void {
    if (msg.method === 'notifications/cancelled' && isObject(msg.params)) {
      const rid = msg.params.requestId;
      if (isId(rid)) running.get(`${ctx.sessionId ?? ''}:${rid}`)?.abort();
    }
  }

  /** A single (non-batch) message: its response, or null when none is due. */
  async function one(
    raw: unknown,
    ctx: RpcContext,
  ): Promise<{ response: unknown | null; sessionId?: string }> {
    if (!isObject(raw) || raw.jsonrpc !== '2.0') {
      return { response: rpcError(null, RPC.invalidRequest, 'Invalid JSON-RPC request.') };
    }
    const hasId = 'id' in raw && raw.id !== undefined;
    if (typeof raw.method !== 'string') {
      // A response to something we never asked: accept and ignore it.
      if (hasId && ('result' in raw || 'error' in raw)) return { response: null };
      return {
        response: rpcError(
          isId(raw.id) ? raw.id : null,
          RPC.invalidRequest,
          'Invalid JSON-RPC request.',
        ),
      };
    }
    if (!hasId) {
      notification(raw, ctx);
      return { response: null };
    }
    if (!isId(raw.id)) {
      return {
        response: rpcError(
          null,
          RPC.invalidRequest,
          'The request id must be a string or a number.',
        ),
      };
    }
    return request(raw, raw.id, ctx);
  }

  async function handle(raw: unknown, ctx: RpcContext): Promise<RpcOutcome> {
    if (ctx.sessionId !== null && !sessions.has(ctx.sessionId)) {
      // The session ended (Plasma restarted): the client must initialize again.
      return {
        status: 404,
        body: rpcError(null, RPC.invalidRequest, 'Unknown session. Initialize again.'),
      };
    }
    if (Array.isArray(raw)) {
      const batchOk = (ctx.protocolVersion ?? '2025-03-26') === '2025-03-26';
      if (!batchOk || raw.length === 0) {
        return {
          status: 400,
          body: rpcError(
            null,
            RPC.invalidRequest,
            batchOk ? 'Empty batch.' : 'Batches are not supported in this protocol version.',
          ),
        };
      }
      const out: unknown[] = [];
      for (const m of raw) {
        const r = await one(m, ctx);
        if (r.response !== null) out.push(r.response);
      }
      return out.length === 0 ? { status: 202 } : { status: 200, body: out };
    }
    const r = await one(raw, ctx);
    if (r.response === null) return { status: 202 };
    const err = isObject(r.response) && 'error' in r.response;
    return {
      status: err && (r.response as { id: unknown }).id === null ? 400 : 200,
      body: r.response,
      ...(r.sessionId ? { sessionId: r.sessionId } : {}),
    };
  }

  return {
    handle,
    /** Abort every call still running (the server is closing). */
    abortAll: () => all.abort(),
    inFlight: () => inFlight,
    sessionCount: () => sessions.size,
  };
}

export type McpHandler = ReturnType<typeof createMcpHandler>;
