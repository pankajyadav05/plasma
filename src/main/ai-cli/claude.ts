import { spawnCli } from './proc';
import { cliEnv } from './proc';
import type { CliRun, CliRunResult } from './types';

/**
 * Claude Code as a chat provider: `claude -p` with stream-json in and out, every
 * built-in tool switched off, and Plasma's own tools offered as one MCP server.
 */

export const CLAUDE_MCP_SERVER = 'plasma';

export interface ClaudeArgsInput {
  model: string;
  system: string;
  /** Path of the 0600 file holding the MCP config (the token is inside, not on argv). */
  mcpConfigPath: string;
  hasTools: boolean;
}

/** Every safety flag is here, in one place, so a test can pin them. */
export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    input.mcpConfigPath,
    '--setting-sources',
    '',
    '--no-session-persistence',
    '--system-prompt',
    input.system,
    '--model',
    input.model,
    ...(input.hasTools ? ['--allowedTools', `mcp__${CLAUDE_MCP_SERVER}`] : []),
  ];
}

export function claudeMcpConfig(endpoint: { url: string; token: string } | null): string {
  return JSON.stringify({
    mcpServers: endpoint
      ? {
          [CLAUDE_MCP_SERVER]: {
            type: 'http',
            url: endpoint.url,
            headers: { Authorization: `Bearer ${endpoint.token}` },
          },
        }
      : {},
  });
}

export function claudeEnv(): NodeJS.ProcessEnv {
  return cliEnv({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
}

/** The user message line for stdin. */
export function claudeUserLine(text: string, images: Array<{ mediaType: string; data: string }>) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text },
        ...images.map((i) => ({
          type: 'image',
          source: { type: 'base64', media_type: i.mediaType, data: i.data },
        })),
      ],
    },
  };
}

export type ClaudeEvent =
  | { kind: 'init'; plasmaConnected: boolean | null; foreignTools: number }
  | { kind: 'delta'; text: string }
  | { kind: 'result'; isError: boolean; text: string; subtype: string }
  | { kind: 'rate-limit'; blocked: boolean; message: string };

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

function formatReset(resetsAtSeconds: unknown): string {
  if (typeof resetsAtSeconds !== 'number' || !Number.isFinite(resetsAtSeconds)) return '';
  const d = new Date(resetsAtSeconds * 1000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? ` until ${hh}:${mm}` : ` until ${d.toLocaleDateString()} ${hh}:${mm}`;
}

/**
 * Line-by-line parser of Claude Code's stream-json output. Only events of the
 * main conversation count (`parent_tool_use_id` null). The final `assistant`
 * message repeats text that was already streamed, so it is ignored.
 */
export function createClaudeParser() {
  let emitted = '';
  let messages = 0;
  return function parse(line: string): ClaudeEvent[] {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return [];
    }
    if (!isObj(msg)) return [];
    if (msg.type === 'system' && msg.subtype === 'init') {
      const servers = Array.isArray(msg.mcp_servers) ? msg.mcp_servers : [];
      const plasma = servers.find((s) => isObj(s) && s.name === CLAUDE_MCP_SERVER);
      return [
        {
          kind: 'init',
          plasmaConnected: isObj(plasma) ? plasma.status === 'connected' : null,
          foreignTools: Array.isArray(msg.tools)
            ? msg.tools.filter(
                (t) => typeof t !== 'string' || !t.startsWith(`mcp__${CLAUDE_MCP_SERVER}__`),
              ).length
            : 0,
        },
      ];
    }
    if (msg.type === 'rate_limit_event' && isObj(msg.rate_limit_info)) {
      const info = msg.rate_limit_info;
      const status = typeof info.status === 'string' ? info.status : 'allowed';
      const blocked = status !== 'allowed' && status !== 'allowed_warning';
      return [
        {
          kind: 'rate-limit',
          blocked,
          message: `Your Claude plan's limit is reached${formatReset(info.resetsAt)}.`,
        },
      ];
    }
    if (msg.type === 'stream_event' && msg.parent_tool_use_id == null && isObj(msg.event)) {
      const ev = msg.event;
      if (ev.type === 'message_start') {
        messages++;
        // Text of a later message must not run into the one before it.
        if (messages > 1 && emitted && !emitted.endsWith('\n')) {
          emitted += '\n';
          return [{ kind: 'delta', text: '\n' }];
        }
        return [];
      }
      if (
        ev.type === 'content_block_delta' &&
        isObj(ev.delta) &&
        ev.delta.type === 'text_delta' &&
        typeof ev.delta.text === 'string' &&
        ev.delta.text
      ) {
        emitted += ev.delta.text;
        return [{ kind: 'delta', text: ev.delta.text }];
      }
      return [];
    }
    if (msg.type === 'result') {
      return [
        {
          kind: 'result',
          isError: msg.is_error === true,
          text: typeof msg.result === 'string' ? msg.result : '',
          subtype: typeof msg.subtype === 'string' ? msg.subtype : '',
        },
      ];
    }
    return [];
  };
}

/** Tokens and keys in a CLI's own message never reach the UI. */
export function redactCliMessage(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]')
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, '[redacted]')
    .slice(0, 600);
}

export async function runClaude(run: CliRun): Promise<CliRunResult> {
  const parse = createClaudeParser();
  let result: Extract<ClaudeEvent, { kind: 'result' }> | null = null;
  let blocked: string | null = null;
  let initProblem: string | null = null;
  let gotText = false;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const proc = spawnCli({
    command: run.launch.command,
    args: [
      ...run.launch.args,
      ...buildClaudeArgs({
        model: run.model,
        system: run.system,
        mcpConfigPath: run.mcpConfigPath ?? '',
        hasTools: run.endpoint !== null,
      }),
    ],
    env: claudeEnv(),
    cwd: run.cwd,
    signal: run.signal,
    timeoutMs: run.timeoutMs,
    onLine(line) {
      for (const ev of parse(line)) {
        if (ev.kind === 'init') {
          if (run.endpoint && ev.plasmaConnected !== true) {
            initProblem =
              "Claude Code could not connect to Plasma's tools. Try again, or update Claude Code.";
            proc.kill();
          }
          if (ev.foreignTools > 0) {
            // Claude Code offers a tool Plasma did not expect: never run it.
            initProblem = 'Claude Code started with its own tools enabled. Update Claude Code.';
            proc.kill();
          }
        } else if (ev.kind === 'delta') {
          gotText = true;
          run.onDelta(ev.text);
        } else if (ev.kind === 'rate-limit') {
          if (ev.blocked) blocked = ev.message;
        } else if (ev.kind === 'result') {
          result = ev;
          // The CLI should exit on its own after the result; make sure it does.
          closeTimer ??= setTimeout(() => proc.kill(), 3_000);
          closeTimer.unref?.();
          proc.closeStdin();
        }
      }
    },
  });

  proc.write(claudeUserLine(run.prompt, run.images));
  // Keep stdin open until the result line: with MCP tools the CLI needs it.
  const exit = await proc.done;
  if (closeTimer) clearTimeout(closeTimer);

  if (run.signal.aborted) return { ok: false, aborted: true, message: '' };
  if (exit.spawnError) {
    return {
      ok: false,
      message:
        exit.spawnError === 'ENOENT'
          ? 'Claude Code is not installed.'
          : `Could not start Claude Code (${exit.spawnError}).`,
    };
  }
  if (initProblem) return { ok: false, message: initProblem };
  if (exit.timedOut) return { ok: false, message: 'Claude Code took too long and was stopped.' };
  const r = result as Extract<ClaudeEvent, { kind: 'result' }> | null;
  if (r && !r.isError) return { ok: true };
  if (blocked) return { ok: false, message: blocked };
  if (r?.isError) {
    const text = redactCliMessage(r.text.trim());
    if (/not logged in|\/login|authenticat/i.test(text)) {
      return {
        ok: false,
        message: 'Not signed in to Claude Code. Run `claude` in a terminal and sign in.',
      };
    }
    return { ok: false, message: text || 'Claude Code reported an error.' };
  }
  const tail = redactCliMessage(exit.stderrTail.trim());
  if (/not logged in|\/login|authenticat/i.test(tail)) {
    return {
      ok: false,
      message: 'Not signed in to Claude Code. Run `claude` in a terminal and sign in.',
    };
  }
  return {
    ok: false,
    message: gotText
      ? 'Claude Code stopped before it finished its answer.'
      : tail || `Claude Code exited without an answer (code ${exit.code ?? 'none'}).`,
  };
}
