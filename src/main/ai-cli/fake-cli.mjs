// A stand-in for `claude -p` and `codex app-server` used by the unit tests.
// Usage: node fake-cli.mjs <claude|codex> [cli args...]
// Behaviour is picked with FAKE_MODE: ok (default) | tool | hang | auth | foreign (claude only)
// FAKE_PID_FILE: where to write this process's pid. FAKE_REJECT: a feature name to refuse.
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const kind = process.argv[2];
const argv = process.argv.slice(3);
const mode = process.env.FAKE_MODE ?? 'ok';
if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const rl = createInterface({ input: process.stdin });

async function mcp(url, token, method, params, id = 1) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
}

if (kind === 'claude') {
  const cfgPath = argv[argv.indexOf('--mcp-config') + 1];
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const server = cfg.mcpServers?.plasma;
  out({
    type: 'system',
    subtype: 'init',
    tools: mode === 'foreign' ? ['Bash'] : server ? ['mcp__plasma__query_database'] : [],
    mcp_servers: server ? [{ name: 'plasma', status: 'connected' }] : [],
  });
  rl.once('line', async () => {
    if (mode === 'auth') {
      out({
        type: 'result',
        is_error: true,
        subtype: 'success',
        result: 'Not logged in · Please run /login',
      });
      process.exit(1);
    }
    if (mode === 'hang') {
      out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start' } });
      out({
        type: 'stream_event',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'working' } },
      });
      setInterval(() => undefined, 1000);
      return;
    }
    out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start' } });
    out({
      type: 'stream_event',
      parent_tool_use_id: 'toolu_sub',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'SUBAGENT' } },
    });
    out({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hel' } },
    });
    if (mode === 'tool' && server) {
      const r = await mcp(
        server.url,
        server.headers.Authorization.replace('Bearer ', ''),
        'tools/call',
        {
          name: 'query_database',
          arguments: { sql: 'select 1' },
        },
      );
      out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start' } });
      out({
        type: 'stream_event',
        parent_tool_use_id: null,
        event: {
          type: 'content_block_delta',
          delta: {
            type: 'text_delta',
            text: `tool:${r.status}:${JSON.stringify(r.body?.result?.content?.[0]?.text)}`,
          },
        },
      });
    } else {
      out({
        type: 'stream_event',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } },
      });
    }
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } });
    out({ type: 'result', is_error: false, subtype: 'success', result: 'hello' });
  });
  rl.on('close', () => process.exit(0));
}

if (kind === 'codex') {
  const reject = process.env.FAKE_REJECT;
  if (reject && argv.some((a, i) => a === reject && argv[i - 1] === '--disable')) {
    process.stderr.write(`Error: Unknown feature flag: ${reject}\n`);
    process.exit(1);
  }
  const cfg = (key) => {
    const i = argv.findIndex((a) => a.startsWith(`${key}=`));
    return i >= 0 ? JSON.parse(argv[i].slice(key.length + 1)) : null;
  };
  const url = cfg('mcp_servers.plasma.url');
  let nextServerId = 100;
  const waiting = new Map();
  const askServer = (method, params) =>
    new Promise((resolve) => {
      const id = nextServerId++;
      waiting.set(id, resolve);
      out({ id, method, params });
    });
  rl.on('line', async (line) => {
    const m = JSON.parse(line);
    if (m.id !== undefined && !m.method) {
      waiting.get(m.id)?.(m);
      return;
    }
    if (m.method === 'initialize') return out({ id: m.id, result: { userAgent: 'fake' } });
    if (m.method === 'thread/start') {
      out({ id: m.id, result: { thread: { id: 'T1' } } });
      if (url)
        out({
          method: 'mcpServer/startupStatus/updated',
          params: { threadId: 'T1', name: 'plasma', status: 'ready', error: null },
        });
      return;
    }
    if (m.method === 'turn/interrupt') return out({ id: m.id, result: {} });
    if (m.method === 'turn/start') {
      out({ id: m.id, result: { turn: { id: 'U1' } } });
      out({ method: 'turn/started', params: { threadId: 'T1', turn: { id: 'U1' } } });
      if (mode === 'hang') {
        out({ method: 'item/agentMessage/delta', params: { threadId: 'T1', delta: 'working' } });
        setInterval(() => undefined, 1000);
        return;
      }
      if (mode === 'auth') {
        out({
          method: 'error',
          params: {
            threadId: 'T1',
            turnId: 'U1',
            willRetry: false,
            error: { message: '401 Unauthorized' },
          },
        });
        out({
          method: 'turn/completed',
          params: {
            threadId: 'T1',
            turn: { id: 'U1', status: 'failed', error: { message: '401 Unauthorized' } },
          },
        });
        return;
      }
      out({ method: 'item/started', params: { threadId: 'T1', item: { type: 'agentMessage' } } });
      out({ method: 'item/agentMessage/delta', params: { threadId: 'T1', delta: 'hel' } });
      out({ method: 'item/agentMessage/delta', params: { threadId: 'SUB', delta: 'SUBAGENT' } });
      out({ method: 'item/agentMessage/delta', params: { threadId: 'T1', delta: 'lo' } });
      // The server asks for a command approval and an MCP elicitation: both must be answered.
      const a1 = await askServer('item/commandExecution/requestApproval', {
        threadId: 'T1',
        command: 'ls',
      });
      const a2 = await askServer('mcpServer/elicitation/request', {
        threadId: 'T1',
        serverName: 'plasma',
      });
      const a3 = await askServer('mcpServer/elicitation/request', {
        threadId: 'T1',
        serverName: 'other',
      });
      out({
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'T1',
          delta: ` [${a1.result?.decision}/${a2.result?.action}/${a3.result?.action}]`,
        },
      });
      if (mode === 'tool' && url) {
        const token = process.env.PLASMA_CHAT_MCP_TOKEN;
        out({ method: 'item/started', params: { threadId: 'T1', item: { type: 'agentMessage' } } });
        const r = await mcp(url, token, 'tools/call', {
          name: 'query_database',
          arguments: { sql: 'select 1' },
        });
        out({
          method: 'item/agentMessage/delta',
          params: {
            threadId: 'T1',
            delta: `tool:${r.status}:${JSON.stringify(r.body?.result?.content?.[0]?.text)}`,
          },
        });
      }
      out({
        method: 'turn/completed',
        params: { threadId: 'T1', turn: { id: 'U1', status: 'completed', error: null } },
      });
    }
  });
  rl.on('close', () => process.exit(0));
}
