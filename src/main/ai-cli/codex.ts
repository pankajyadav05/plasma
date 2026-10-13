import { redactCliMessage } from './claude';
import { cliEnv, spawnCli } from './proc';
import type { CliProcess } from './proc';
import type { CliRun, CliRunResult } from './types';

/**
 * Codex as a chat provider: `codex app-server` (JSON-RPC over stdio), a
 * read-only sandbox in an empty folder, every tool feature that could reach the
 * machine switched off, and Plasma's own tools offered as one MCP server.
 */

export const CODEX_MCP_SERVER = 'plasma';
export const CODEX_TOKEN_ENV = 'PLASMA_CHAT_MCP_TOKEN';

/**
 * Features that give the model shell, file, browser, app or sub-agent powers.
 *
 * `code_mode` and `code_mode_host` are NOT here on purpose: in this Codex a
 * connected MCP server's tools can only be called from code mode's `exec`
 * (a JavaScript sandbox with no shell, file or network access of its own). With
 * them off the model says the tool "isn't available". The tools the JavaScript
 * can reach are the ones left enabled, which is only Plasma's server.
 */
export const CODEX_DISABLED_FEATURES = [
  'shell_tool',
  'unified_exec',
  'apps',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'image_generation',
  'multi_agent',
  'plugins',
  'hooks',
  'view_image',
  'tool_suggest',
  'skill_search',
  'sleep_tool',
  'goals',
  'in_app_browser',
  'shell_snapshot',
  'skill_mcp_dependency_install',
  'workspace_dependencies',
  'worktrees',
  'realtime_conversation',
  'tool_call_mcp_elicitation',
  'code_mode_only',
  'collaboration_modes',
  'agent_message_board',
  'default_mode_request_user_input',
  'enable_fanout',
  'guardian_approval',
  'in_app_local_automation',
  'remote_plugin',
  'mentions_v2',
] as const;

/** argv for `codex app-server`. The bearer token is NOT here: it rides in the child env. */
export function buildCodexArgs(input: {
  endpointUrl: string | null;
  skipFeatures?: ReadonlySet<string>;
}): string[] {
  const args = ['app-server'];
  for (const f of CODEX_DISABLED_FEATURES) {
    if (input.skipFeatures?.has(f)) continue;
    args.push('--disable', f);
  }
  args.push('-c', 'web_search="disabled"');
  if (input.endpointUrl) {
    args.push(
      '-c',
      `mcp_servers.${CODEX_MCP_SERVER}.url=${JSON.stringify(input.endpointUrl)}`,
      '-c',
      `mcp_servers.${CODEX_MCP_SERVER}.bearer_token_env_var=${JSON.stringify(CODEX_TOKEN_ENV)}`,
      '-c',
      // Plasma's own cards are the approval; Codex must not ask a second time.
      `mcp_servers.${CODEX_MCP_SERVER}.default_tools_approval_mode="approve"`,
    );
  }
  return args;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The answer to a request the server sends us. Only Plasma's own MCP tools are
 * approved (Plasma's cards are the real approval); everything else is declined,
 * so a turn never hangs and nothing else ever runs.
 */
export function answerServerRequest(
  method: string,
  params: unknown,
): { result: unknown } | { error: { code: number; message: string } } {
  const p = isObj(params) ? params : {};
  switch (method) {
    case 'mcpServer/elicitation/request':
      return p.serverName === CODEX_MCP_SERVER
        ? { result: { action: 'accept', content: null, _meta: null } }
        : { result: { action: 'decline', content: null, _meta: null } };
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { result: { decision: 'decline' } };
    case 'applyPatchApproval':
    case 'execCommandApproval':
      return { result: { decision: 'denied' } };
    case 'item/permissions/requestApproval':
      return { result: { permissions: {}, scope: 'turn' } };
    case 'item/tool/requestUserInput':
      return { result: { answers: {} } };
    case 'item/tool/call':
      return { result: { contentItems: [], success: false } };
    default:
      return { error: { code: -32601, message: 'Not supported by Plasma.' } };
  }
}

export type CodexEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'message-start' }
  | { kind: 'turn-started'; turnId: string }
  | { kind: 'turn-done'; status: string; error: string | null }
  | { kind: 'fatal'; message: string }
  | { kind: 'mcp-status'; name: string; status: string; error: string | null };

/** One notification → what Plasma does with it. Sub-agent threads are ignored. */
export function parseCodexNotification(
  method: string,
  params: unknown,
  threadId: string,
): CodexEvent | null {
  if (!isObj(params)) return null;
  if (method === 'mcpServer/startupStatus/updated') {
    if (typeof params.name !== 'string') return null;
    return {
      kind: 'mcp-status',
      name: params.name,
      status: String(params.status),
      error: typeof params.error === 'string' ? params.error : null,
    };
  }
  if (params.threadId !== threadId) return null;
  switch (method) {
    case 'item/agentMessage/delta':
      return typeof params.delta === 'string' && params.delta
        ? { kind: 'delta', text: params.delta }
        : null;
    case 'item/started':
      return isObj(params.item) && params.item.type === 'agentMessage'
        ? { kind: 'message-start' }
        : null;
    case 'turn/started':
      return isObj(params.turn) && typeof params.turn.id === 'string'
        ? { kind: 'turn-started', turnId: params.turn.id }
        : null;
    case 'turn/completed': {
      const turn = isObj(params.turn) ? params.turn : {};
      const err = isObj(turn.error) && typeof turn.error.message === 'string' ? turn.error : null;
      return {
        kind: 'turn-done',
        status: typeof turn.status === 'string' ? turn.status : 'completed',
        error: err ? (err.message as string) : null,
      };
    }
    case 'error': {
      if (params.willRetry === true) return null;
      const e = isObj(params.error) ? params.error : {};
      return {
        kind: 'fatal',
        message: typeof e.message === 'string' ? e.message : 'Codex reported an error.',
      };
    }
    default:
      return null;
  }
}

const NOT_SIGNED_IN = 'Not signed in to Codex. Run `codex login` in a terminal.';
const AUTH_RE =
  /not logged in|log ?in required|unauthori[sz]ed|401|sign in|token.*(expired|invalid)/i;

export function codexErrorMessage(raw: string): string {
  const text = redactCliMessage(raw.trim());
  return AUTH_RE.test(text) ? NOT_SIGNED_IN : text || 'Codex reported an error.';
}

type AttemptResult =
  | { done: CliRunResult }
  | { retryWithout: string }
  | { done: CliRunResult; unknownFeature?: undefined };

export async function runCodex(run: CliRun): Promise<CliRunResult> {
  const skip = new Set<string>();
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = await runOnce(run, skip);
    if ('retryWithout' in r) {
      skip.add(r.retryWithout);
      continue;
    }
    return r.done;
  }
  return { ok: false, message: 'Codex could not start with the installed version.' };
}

async function runOnce(run: CliRun, skip: ReadonlySet<string>): Promise<AttemptResult> {
  let nextId = 0;
  const waiting = new Map<number, (m: Json) => void>();
  let threadId = '';
  let turnId = '';
  let fatal: string | null = null;
  let turnDone: Extract<CodexEvent, { kind: 'turn-done' }> | null = null;
  let mcpFailed: string | null = null;
  let mcpReady = false;
  const mcpWaiters: Array<() => void> = [];
  let sawMessage = false;
  let emitted = '';
  let proc: CliProcess | null = null;
  let finishTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveTurn: () => void = () => undefined;
  const turnFinished = new Promise<void>((r) => {
    resolveTurn = r;
  });

  const request = (method: string, params: unknown, timeoutMs = 30_000) =>
    new Promise<Json>((resolve, reject) => {
      const id = ++nextId;
      const t = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`Codex did not answer ${method}.`));
      }, timeoutMs);
      t.unref?.();
      waiting.set(id, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      proc?.write({ id, method, params });
    });

  proc = spawnCli({
    command: run.launch.command,
    args: [
      ...run.launch.args,
      ...buildCodexArgs({ endpointUrl: run.endpoint?.url ?? null, skipFeatures: skip }),
    ],
    env: cliEnv(run.endpoint ? { [CODEX_TOKEN_ENV]: run.endpoint.token } : {}),
    cwd: run.cwd,
    timeoutMs: run.timeoutMs,
    onLine(line) {
      let m: unknown;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (!isObj(m)) return;
      const hasId = m.id !== undefined && m.id !== null;
      if (hasId && typeof m.method === 'string') {
        // A request from the server: always answer, so the turn never hangs.
        const a = answerServerRequest(m.method, m.params);
        proc?.write({ id: m.id, ...a });
        return;
      }
      if (hasId) {
        waiting.get(m.id as number)?.(m);
        waiting.delete(m.id as number);
        return;
      }
      if (typeof m.method !== 'string') return;
      const ev = parseCodexNotification(m.method, m.params, threadId);
      if (!ev) return;
      switch (ev.kind) {
        case 'mcp-status':
          if (ev.name !== CODEX_MCP_SERVER) break;
          if (ev.status === 'ready') {
            mcpReady = true;
            for (const w of mcpWaiters.splice(0)) w();
          } else if (ev.status === 'failed' || ev.status === 'cancelled') {
            mcpFailed = ev.error ?? 'failed';
            for (const w of mcpWaiters.splice(0)) w();
          }
          break;
        case 'message-start':
          if (sawMessage && emitted && !emitted.endsWith('\n')) {
            emitted += '\n';
            run.onDelta('\n');
          }
          sawMessage = true;
          break;
        case 'delta':
          emitted += ev.text;
          run.onDelta(ev.text);
          break;
        case 'turn-started':
          turnId = ev.turnId;
          break;
        case 'fatal':
          fatal ??= ev.message;
          resolveTurn();
          break;
        case 'turn-done':
          turnDone = ev;
          resolveTurn();
          break;
      }
    },
  });

  const onAbort = () => {
    if (threadId && turnId)
      proc?.write({ id: ++nextId, method: 'turn/interrupt', params: { threadId, turnId } });
    finishTimer = setTimeout(() => proc?.kill(), 250);
    finishTimer.unref?.();
  };
  if (run.signal.aborted) onAbort();
  else run.signal.addEventListener('abort', onAbort, { once: true });

  // The program ending at any point ends the wait.
  const exited = proc.done.then((x) => {
    resolveTurn();
    for (const w of waiting.values()) w({ error: { message: 'Codex stopped.' } });
    return x;
  });

  let failure: string | null = null;
  try {
    const init = await request('initialize', {
      clientInfo: { name: 'plasma', title: 'Plasma', version: run.appVersion ?? '0' },
      capabilities: null,
    });
    if (init.error) throw new Error(String((init.error as Json).message ?? 'initialize failed'));
    proc.write({ method: 'initialized' });

    const started = await request('thread/start', {
      cwd: run.cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
      ...(run.model ? { model: run.model } : {}),
      developerInstructions: run.system,
    });
    const thread =
      isObj(started.result) && isObj(started.result.thread) ? started.result.thread : null;
    if (!thread || typeof thread.id !== 'string') {
      const e = isObj(started.error) ? String(started.error.message ?? '') : '';
      throw new Error(e || 'Codex did not start a conversation.');
    }
    threadId = thread.id;

    if (run.endpoint && !mcpReady && !mcpFailed) {
      await Promise.race([
        new Promise<void>((r) => mcpWaiters.push(r)),
        new Promise<void>((r) => {
          const t = setTimeout(r, 15_000);
          t.unref?.();
        }),
      ]);
    }
    if (run.endpoint && mcpFailed) {
      throw new Error("Codex could not connect to Plasma's tools.");
    }

    const turn = await request('turn/start', {
      threadId,
      input: [
        { type: 'text', text: run.prompt, text_elements: [] },
        ...run.images.map((i) => ({ type: 'image', url: i.url })),
      ],
      ...(run.model ? { model: run.model } : {}),
      ...(run.effort ? { effort: run.effort } : {}),
    });
    if (turn.error) {
      throw new Error(String((turn.error as Json).message ?? 'Codex refused the message.'));
    }
    if (isObj(turn.result) && isObj(turn.result.turn) && typeof turn.result.turn.id === 'string') {
      turnId ||= turn.result.turn.id;
    }
    await turnFinished;
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }

  // The turn is over: let the program go.
  proc.closeStdin();
  const killer = setTimeout(() => proc?.kill(), 1_500);
  killer.unref?.();
  const exit = await exited;
  clearTimeout(killer);
  if (finishTimer) clearTimeout(finishTimer);
  run.signal.removeEventListener('abort', onAbort);

  if (run.signal.aborted) return { done: { ok: false, aborted: true, message: '' } };

  const unknown = /Unknown feature flag:\s*([\w.-]+)/i.exec(exit.stderrTail);
  if (unknown?.[1] && !threadId && !skip.has(unknown[1])) return { retryWithout: unknown[1] };

  if (exit.spawnError) {
    return {
      done: {
        ok: false,
        message:
          exit.spawnError === 'ENOENT'
            ? 'Codex is not installed.'
            : `Could not start Codex (${exit.spawnError}).`,
      },
    };
  }
  if (exit.timedOut)
    return { done: { ok: false, message: 'Codex took too long and was stopped.' } };
  const td = turnDone as Extract<CodexEvent, { kind: 'turn-done' }> | null;
  if (td && td.status === 'completed' && !fatal) return { done: { ok: true } };
  const message = fatal ?? td?.error ?? failure ?? exit.stderrTail;
  if (td && td.status === 'interrupted') {
    return { done: { ok: false, message: 'Codex stopped before it finished.' } };
  }
  return { done: { ok: false, message: codexErrorMessage(message || '') } };
}
