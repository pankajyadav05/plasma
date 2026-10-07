import { createHash, timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { MCP_MAX_BODY_BYTES } from '@shared/mcp';
import { type McpHandler, RPC, isSupportedVersion, rpcError } from './protocol';

/**
 * The HTTP face of the MCP server: MCP Streamable HTTP, POST /mcp only, JSON
 * answers (no SSE). Everything that decides "may this request in" lives here
 * and runs before a byte of the body is parsed: Host, Origin, bearer token.
 */

export interface McpHttpOptions {
  handler: McpHandler;
  /** The current bearer token (read per request so Regenerate takes effect at once). */
  token: () => string;
  log?: (message: string) => void;
}

export interface McpHttpServer {
  /** Resolves with the bound port; rejects with the listen error (`EADDRINUSE`...). */
  listen(port: number): Promise<number>;
  close(): Promise<void>;
  readonly port: number | null;
}

/** Constant-time comparison of two secrets (hashed first so the lengths do not leak). */
export function tokensEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** The token from an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
  return m?.[1] ?? null;
}

/** DNS-rebinding guard: only the literal loopback names on our own port. */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

function send(
  res: ServerResponse,
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
): void {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    ...(body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(text);
}

const header = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/** The body as text, or the HTTP status to refuse it with. */
function readBody(
  req: IncomingMessage,
): Promise<{ ok: true; text: string } | { ok: false; status: number }> {
  return new Promise((resolve) => {
    const declared = Number(header(req, 'content-length'));
    if (Number.isFinite(declared) && declared > MCP_MAX_BODY_BYTES) {
      resolve({ ok: false, status: 413 });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (r: { ok: true; text: string } | { ok: false; status: number }) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MCP_MAX_BODY_BYTES) {
        finish({ ok: false, status: 413 });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => finish({ ok: false, status: 400 }));
    req.on('aborted', () => finish({ ok: false, status: 400 }));
  });
}

export function createMcpHttpServer(opts: McpHttpOptions): McpHttpServer {
  let server: Server | null = null;
  let boundPort: number | null = null;

  async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const port = boundPort ?? 0;
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/mcp') return send(res, 404);
    if (!hostAllowed(header(req, 'host'), port))
      return send(res, 403, rpcError(null, RPC.invalidRequest, 'Forbidden host.'));
    // Browsers always send Origin on cross-site requests; local MCP clients never do.
    if (req.headers.origin !== undefined) {
      return send(res, 403, rpcError(null, RPC.invalidRequest, 'Forbidden origin.'));
    }
    const presented = bearerToken(header(req, 'authorization'));
    if (presented === null || !tokensEqual(presented, opts.token())) {
      return send(res, 401, rpcError(null, RPC.invalidRequest, 'Missing or wrong token.'), {
        'WWW-Authenticate': 'Bearer realm="plasma"',
      });
    }
    if (req.method !== 'POST') {
      // No server-initiated stream (GET) and no session teardown (DELETE).
      return send(res, 405, undefined, { Allow: 'POST' });
    }
    const type = (header(req, 'content-type') ?? '').split(';')[0]?.trim().toLowerCase();
    if (type !== 'application/json') {
      return send(res, 415, rpcError(null, RPC.invalidRequest, 'Send application/json.'));
    }
    const version = header(req, 'mcp-protocol-version') ?? null;
    if (version !== null && !isSupportedVersion(version)) {
      return send(
        res,
        400,
        rpcError(null, RPC.invalidRequest, 'Unsupported MCP-Protocol-Version.'),
      );
    }
    const body = await readBody(req);
    if (!body.ok)
      return send(
        res,
        body.status,
        rpcError(
          null,
          RPC.invalidRequest,
          body.status === 413 ? 'Body too large.' : 'Bad request.',
        ),
      );
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.text);
    } catch {
      return send(res, 400, rpcError(null, RPC.parse, 'Parse error.'));
    }
    const outcome = await opts.handler.handle(parsed, {
      protocolVersion: version,
      sessionId: header(req, 'mcp-session-id') ?? null,
    });
    send(
      res,
      outcome.status,
      outcome.body,
      outcome.sessionId ? { 'Mcp-Session-Id': outcome.sessionId } : {},
    );
  }

  return {
    get port() {
      return boundPort;
    },
    listen(port) {
      return new Promise((resolve, reject) => {
        const s = createServer((req, res) => {
          onRequest(req, res).catch((err) => {
            opts.log?.(`request failed: ${err instanceof Error ? err.message : String(err)}`);
            if (!res.headersSent) send(res, 500, rpcError(null, RPC.internal, 'Internal error.'));
            else res.destroy();
          });
        });
        // Slow or stalled senders must not hold a socket (the reply itself may take minutes).
        s.headersTimeout = 10_000;
        s.requestTimeout = 30_000;
        s.maxHeadersCount = 50;
        s.once('error', reject);
        // 127.0.0.1 only: never a wildcard address.
        s.listen(port, '127.0.0.1', () => {
          s.off('error', reject);
          server = s;
          const addr = s.address();
          boundPort = typeof addr === 'object' && addr ? addr.port : port;
          resolve(boundPort);
        });
      });
    },
    close() {
      opts.handler.abortAll();
      const s = server;
      server = null;
      boundPort = null;
      if (!s) return Promise.resolve();
      return new Promise((resolve) => {
        s.close(() => resolve());
        s.closeAllConnections();
      });
    },
  };
}
