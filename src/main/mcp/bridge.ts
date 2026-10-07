import { existsSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

/**
 * The stdio bridge for MCP clients that only speak stdio (Claude Desktop...).
 * Reads one JSON-RPC message per line on stdin, POSTs it to the running
 * Plasma (port from `<userData>/mcp.json`, token from `<userData>/mcp-token`)
 * and writes each answer as one line on stdout. Notifications produce no
 * output. Plain Node: no Electron, no imports from the app (it is built as
 * its own entry, and also runs directly with `node`).
 *
 * Nothing but protocol messages goes to stdout; diagnostics go to stderr.
 */

export const NOT_RUNNING_MESSAGE = 'Open Plasma and turn on the MCP server in Settings.';
const SERVER_ERROR = -32000;

export interface BridgeOptions {
  userDataDir: string;
  stdin: Readable;
  stdout: Writable;
  stderr?: Writable;
  /** Test seam: is this pid running. */
  pidAlive?: (pid: number) => boolean;
}

/** Where Plasma keeps its profile when PLASMA_USER_DATA is not set (the folder that holds mcp.json wins). */
export function candidateUserDataDirs(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): string[] {
  if (env.PLASMA_USER_DATA) return [env.PLASMA_USER_DATA];
  const home = homedir();
  const base =
    platform === 'darwin'
      ? join(home, 'Library', 'Application Support')
      : platform === 'win32'
        ? (env.APPDATA ?? join(home, 'AppData', 'Roaming'))
        : (env.XDG_CONFIG_HOME ?? join(home, '.config'));
  return [join(base, 'Plasma'), join(base, 'plasma')];
}

export function pickUserDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): string {
  const dirs = candidateUserDataDirs(env, platform);
  return dirs.find((d) => existsSync(join(d, 'mcp.json'))) ?? (dirs[0] as string);
}

interface Endpoint {
  port: number;
  token: string;
}

/** Whether a process with this pid is running (EPERM: someone else's, so not Plasma). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The running Plasma, from `mcp.json` + the token file. A file left behind by
 * a crash names a pid that is gone: then nothing is sent anywhere (a stranger
 * may hold that port by now, and it must never see the token).
 */
export function readEndpoint(
  dir: string,
  alive: (pid: number) => boolean = pidAlive,
): Endpoint | null {
  try {
    const info = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8')) as {
      port?: unknown;
      pid?: unknown;
    };
    const port = Number(info.port);
    if (typeof info.pid !== 'number' || !alive(info.pid)) return null;
    const token = readFileSync(join(dir, 'mcp-token'), 'utf8').trim();
    if (!Number.isInteger(port) || port < 1 || !token) return null;
    return { port, token };
  } catch {
    return null;
  }
}

interface Reply {
  status: number;
  body: string;
  sessionId: string | null;
}

/** node:http, not fetch: a proposed change may wait minutes for the user and fetch gives up after 5. */
function post(ep: Endpoint, body: string, headers: Record<string, string>): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: ep.port,
        path: '/mcp',
        method: 'POST',
        headers: {
          Host: `127.0.0.1:${ep.port}`,
          Authorization: `Bearer ${ep.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const sid = res.headers['mcp-session-id'];
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            sessionId: Array.isArray(sid) ? (sid[0] ?? null) : (sid ?? null),
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function errorMessage(body: Record<string, unknown>, status: number): string {
  const e = body.error;
  const m = isObject(e) && typeof e.message === 'string' ? e.message : '';
  return `Plasma refused the request (${status})${m ? `: ${m}` : ''}`;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

export function runBridge(opts: BridgeOptions): Promise<void> {
  let sessionId: string | null = null;
  let protocolVersion: string | null = null;
  let initRequest: string | null = null;
  const pending = new Set<Promise<void>>();

  const write = (message: unknown) => {
    opts.stdout.write(`${JSON.stringify(message)}\n`);
  };
  const fail = (id: unknown, message: string, code = SERVER_ERROR) =>
    write({
      jsonrpc: '2.0',
      id: typeof id === 'string' || typeof id === 'number' ? id : null,
      error: { code, message },
    });

  const headers = (): Record<string, string> => ({
    ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    ...(protocolVersion ? { 'MCP-Protocol-Version': protocolVersion } : {}),
  });

  /** One POST; remembers the session and protocol version an initialize answer carries. */
  async function send(ep: Endpoint, line: string, parsed: unknown): Promise<Reply> {
    const isInit = isObject(parsed) && parsed.method === 'initialize';
    const reply = await post(ep, line, isInit ? {} : headers());
    if (isInit) {
      initRequest = line;
      sessionId = reply.sessionId;
      try {
        const r = JSON.parse(reply.body) as { result?: { protocolVersion?: unknown } };
        if (typeof r.result?.protocolVersion === 'string')
          protocolVersion = r.result.protocolVersion;
      } catch {}
    }
    return reply;
  }

  async function handle(line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail(null, 'Parse error.', -32700);
      return;
    }
    const wantsAnswer =
      Array.isArray(parsed) ||
      (isObject(parsed) && typeof parsed.method === 'string' && parsed.id !== undefined);
    const id = isObject(parsed) ? parsed.id : null;
    const ep = readEndpoint(opts.userDataDir, opts.pidAlive);
    if (!ep) {
      if (wantsAnswer) fail(id, NOT_RUNNING_MESSAGE);
      return;
    }
    try {
      let reply = await send(ep, line, parsed);
      if (
        reply.status === 404 &&
        initRequest &&
        !(isObject(parsed) && parsed.method === 'initialize')
      ) {
        // Plasma restarted and forgot the session: start a new one, then retry once.
        sessionId = null;
        const re = await send(ep, initRequest, JSON.parse(initRequest));
        if (re.status === 200) {
          await post(
            ep,
            JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
            headers(),
          );
          reply = await send(ep, line, parsed);
        }
      }
      if (reply.status === 401) {
        if (wantsAnswer)
          fail(id, 'Plasma refused the token. Restart this client so it picks up the new one.');
        return;
      }
      if (reply.status === 202 || reply.body.trim() === '') return;
      try {
        const body = JSON.parse(reply.body) as unknown;
        // The server's own refusals (413, 403, 400...) carry no id: give the client's request its answer.
        if (reply.status >= 400 && isObject(body) && body.id == null) {
          if (wantsAnswer) fail(id, errorMessage(body, reply.status));
          return;
        }
        write(body);
      } catch {
        if (wantsAnswer) fail(id, 'Plasma sent an answer this bridge could not read.');
      }
    } catch {
      if (wantsAnswer) fail(id, NOT_RUNNING_MESSAGE);
    }
  }

  return new Promise((resolve) => {
    const rl = createInterface({ input: opts.stdin, crlfDelay: Number.POSITIVE_INFINITY });
    rl.on('line', (raw) => {
      const line = raw.trim();
      if (!line) return;
      const p = handle(line).finally(() => pending.delete(p));
      pending.add(p);
    });
    rl.on('close', () => {
      Promise.allSettled([...pending]).then(() => resolve());
    });
  });
}

// Run directly (`node mcp-bridge.js`, or `ELECTRON_RUN_AS_NODE=1 electron mcp-bridge.js`).
const entry = process.argv[1] ?? '';
if (entry && (entry === fileURLToPath(import.meta.url) || /mcp-bridge\.(?:js|ts)$/.test(entry))) {
  void runBridge({
    userDataDir: pickUserDataDir(),
    stdin: process.stdin,
    stdout: process.stdout,
  });
}
