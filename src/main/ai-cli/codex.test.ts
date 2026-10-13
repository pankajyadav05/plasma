import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CODEX_DISABLED_FEATURES,
  CODEX_TOKEN_ENV,
  answerServerRequest,
  buildCodexArgs,
  codexErrorMessage,
  parseCodexNotification,
  runCodex,
} from './codex';
import { FAKE_CLI as FAKE, alive, unsetEnv, waitDead } from './test-util';
import { createToolEndpoint } from './tool-endpoint';
import type { CliRun } from './types';

describe('buildCodexArgs', () => {
  const args = buildCodexArgs({ endpointUrl: 'http://127.0.0.1:4000/mcp' });

  it('starts the app server and disables every power feature', () => {
    expect(args[0]).toBe('app-server');
    const disabled = args.filter((_a, i) => args[i - 1] === '--disable');
    expect(disabled).toEqual([...CODEX_DISABLED_FEATURES]);
    for (const f of [
      'shell_tool',
      'unified_exec',
      'apps',
      'browser_use',
      'computer_use',
      'image_generation',
      'multi_agent',
      'plugins',
      'hooks',
      'view_image',
      'worktrees',
      'code_mode_only',
      'collaboration_modes',
      'guardian_approval',
    ]) {
      expect(disabled).toContain(f);
    }
    expect(args).toContain('web_search="disabled"');
  });

  it('keeps code mode on: it is the only way this Codex reaches an MCP tool', () => {
    expect(CODEX_DISABLED_FEATURES).not.toContain('code_mode');
    expect(CODEX_DISABLED_FEATURES).not.toContain('code_mode_host');
  });

  it('offers the plasma server by URL, with the token only named, never carried', () => {
    expect(args).toContain('mcp_servers.plasma.url="http://127.0.0.1:4000/mcp"');
    expect(args).toContain(`mcp_servers.plasma.bearer_token_env_var="${CODEX_TOKEN_ENV}"`);
    expect(args).toContain('mcp_servers.plasma.default_tools_approval_mode="approve"');
    expect(args.join(' ')).not.toMatch(/Bearer\s|Authorization|\.bearer_token=|http_headers/i);
  });

  it('adds no MCP server for a chat without tools', () => {
    const none = buildCodexArgs({ endpointUrl: null });
    expect(none.join(' ')).not.toContain('mcp_servers');
    expect(none).toContain('web_search="disabled"');
  });

  it('can leave out a feature an older Codex does not know', () => {
    const fewer = buildCodexArgs({ endpointUrl: null, skipFeatures: new Set(['mentions_v2']) });
    expect(fewer).not.toContain('mentions_v2');
    expect(fewer).toContain('goals');
  });
});

describe('answerServerRequest', () => {
  it('approves Plasma MCP calls and nothing else', () => {
    expect(answerServerRequest('mcpServer/elicitation/request', { serverName: 'plasma' })).toEqual({
      result: { action: 'accept', content: null, _meta: null },
    });
    expect(answerServerRequest('mcpServer/elicitation/request', { serverName: 'evil' })).toEqual({
      result: { action: 'decline', content: null, _meta: null },
    });
    expect(answerServerRequest('mcpServer/elicitation/request', null)).toEqual({
      result: { action: 'decline', content: null, _meta: null },
    });
  });

  it('declines commands, file changes and permissions, empties user input', () => {
    expect(answerServerRequest('item/commandExecution/requestApproval', {})).toEqual({
      result: { decision: 'decline' },
    });
    expect(answerServerRequest('item/fileChange/requestApproval', {})).toEqual({
      result: { decision: 'decline' },
    });
    expect(answerServerRequest('execCommandApproval', {})).toEqual({
      result: { decision: 'denied' },
    });
    expect(answerServerRequest('applyPatchApproval', {})).toEqual({
      result: { decision: 'denied' },
    });
    expect(answerServerRequest('item/permissions/requestApproval', {})).toEqual({
      result: { permissions: {}, scope: 'turn' },
    });
    expect(answerServerRequest('item/tool/requestUserInput', {})).toEqual({
      result: { answers: {} },
    });
    expect(answerServerRequest('item/tool/call', {})).toEqual({
      result: { contentItems: [], success: false },
    });
  });

  it('answers an unknown request with an error so the turn never hangs', () => {
    expect(answerServerRequest('something/new', {})).toMatchObject({ error: { code: -32601 } });
  });
});

describe('parseCodexNotification', () => {
  const T = 'thread-1';
  it('streams agent message text of our thread only', () => {
    expect(
      parseCodexNotification('item/agentMessage/delta', { threadId: T, delta: 'hi' }, T),
    ).toEqual({
      kind: 'delta',
      text: 'hi',
    });
    expect(
      parseCodexNotification('item/agentMessage/delta', { threadId: 'sub-agent', delta: 'x' }, T),
    ).toBeNull();
    expect(
      parseCodexNotification('item/agentMessage/delta', { threadId: T, delta: '' }, T),
    ).toBeNull();
  });

  it('ignores reasoning and command output', () => {
    expect(
      parseCodexNotification('item/reasoning/textDelta', { threadId: T, delta: 'x' }, T),
    ).toBeNull();
    expect(
      parseCodexNotification('item/commandExecution/outputDelta', { threadId: T }, T),
    ).toBeNull();
  });

  it('marks the start of each agent message', () => {
    expect(
      parseCodexNotification('item/started', { threadId: T, item: { type: 'agentMessage' } }, T),
    ).toEqual({ kind: 'message-start' });
    expect(
      parseCodexNotification('item/started', { threadId: T, item: { type: 'reasoning' } }, T),
    ).toBeNull();
  });

  it('knows when its own turn is over, and why', () => {
    expect(
      parseCodexNotification('turn/completed', { threadId: T, turn: { status: 'completed' } }, T),
    ).toEqual({ kind: 'turn-done', status: 'completed', error: null });
    expect(
      parseCodexNotification(
        'turn/completed',
        { threadId: T, turn: { status: 'failed', error: { message: 'boom' } } },
        T,
      ),
    ).toEqual({ kind: 'turn-done', status: 'failed', error: 'boom' });
    expect(
      parseCodexNotification(
        'turn/completed',
        { threadId: 'other', turn: { status: 'completed' } },
        T,
      ),
    ).toBeNull();
  });

  it('only a final error is fatal', () => {
    expect(
      parseCodexNotification(
        'error',
        { threadId: T, willRetry: false, error: { message: 'Selected model is at capacity' } },
        T,
      ),
    ).toEqual({ kind: 'fatal', message: 'Selected model is at capacity' });
    expect(
      parseCodexNotification('error', { threadId: T, willRetry: true, error: { message: 'x' } }, T),
    ).toBeNull();
  });

  it('reads the plasma server startup status from any thread', () => {
    expect(
      parseCodexNotification(
        'mcpServer/startupStatus/updated',
        { threadId: 'z', name: 'plasma', status: 'ready', error: null },
        T,
      ),
    ).toEqual({ kind: 'mcp-status', name: 'plasma', status: 'ready', error: null });
  });
});

describe('codexErrorMessage', () => {
  it('turns an auth failure into the sign-in sentence', () => {
    expect(codexErrorMessage('401 Unauthorized')).toBe(
      'Not signed in to Codex. Run `codex login` in a terminal.',
    );
  });
  it('keeps the CLI message otherwise, without tokens', () => {
    expect(codexErrorMessage('Selected model is at capacity')).toBe(
      'Selected model is at capacity',
    );
    expect(codexErrorMessage('boom Bearer abcdef0123456789')).toBe('boom Bearer [redacted]');
    expect(codexErrorMessage('')).toBe('Codex reported an error.');
  });
});

describe('runCodex with a fake CLI', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plasma-codex-test-'));
  });
  afterEach(() => {
    unsetEnv('FAKE_MODE', 'FAKE_PID_FILE', 'FAKE_REJECT');
    rmSync(dir, { recursive: true, force: true });
  });

  function baseRun(over: Partial<CliRun> = {}, ep: { url: string; token: string } | null = null) {
    const deltas: string[] = [];
    const run: CliRun = {
      launch: { command: process.execPath, args: [FAKE, 'codex'] },
      cwd: dir,
      model: 'gpt-6-luna',
      system: 'sys',
      prompt: 'hi',
      images: [],
      endpoint: ep,
      onDelta: (t) => deltas.push(t),
      signal: new AbortController().signal,
      timeoutMs: 20_000,
      ...over,
    };
    return { run, deltas };
  }

  it('streams our thread, answers every server request, finishes ok', async () => {
    const { run, deltas } = baseRun();
    expect(await runCodex(run)).toEqual({ ok: true });
    const text = deltas.join('');
    expect(text).not.toContain('SUBAGENT');
    // command approval declined; plasma elicitation accepted; others declined
    expect(text).toBe('hello [decline/accept/decline]');
  });

  it('runs a tool call with the token from the environment', async () => {
    process.env.FAKE_MODE = 'tool';
    const endpoint = createToolEndpoint();
    const calls: string[] = [];
    const reg = await endpoint.register({
      tools: [
        {
          name: 'query_database',
          title: 'q',
          description: 'd',
          inputSchema: { type: 'object' },
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
          },
        },
      ],
      call: async (name, args) => {
        calls.push(`${name}:${JSON.stringify(args)}`);
        return '{"rows":[1]}';
      },
    });
    try {
      const { run, deltas } = baseRun({}, { url: reg.url, token: reg.token });
      expect(await runCodex(run)).toEqual({ ok: true });
      expect(calls).toEqual(['query_database:{"sql":"select 1"}']);
      expect(deltas.join('')).toContain('tool:200:');
      // The second agent message starts on its own line.
      expect(deltas.join('')).toContain(']\ntool:');
    } finally {
      reg.revoke();
      await endpoint.close();
    }
  });

  it('retries without a feature flag the installed Codex does not know', async () => {
    process.env.FAKE_REJECT = 'mentions_v2';
    const { run } = baseRun();
    expect(await runCodex(run)).toEqual({ ok: true });
  });

  it('turns a failed turn with an auth error into the sign-in sentence', async () => {
    process.env.FAKE_MODE = 'auth';
    const { run } = baseRun();
    expect(await runCodex(run)).toEqual({
      ok: false,
      message: 'Not signed in to Codex. Run `codex login` in a terminal.',
    });
  });

  it('reports a program that is not there', async () => {
    const { run } = baseRun({ launch: { command: join(dir, 'nope'), args: [] } });
    expect(await runCodex(run)).toEqual({ ok: false, message: 'Codex is not installed.' });
  });

  it('Stop interrupts, kills the process and leaves nothing behind', async () => {
    process.env.FAKE_MODE = 'hang';
    process.env.FAKE_PID_FILE = join(dir, 'pid');
    const ctl = new AbortController();
    const { run, deltas } = baseRun({ signal: ctl.signal });
    const p = runCodex(run);
    for (let i = 0; i < 100 && deltas.length === 0; i++)
      await new Promise((r) => setTimeout(r, 50));
    expect(deltas.join('')).toContain('working');
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
    expect(alive(pid)).toBe(true);
    ctl.abort();
    const res = await p;
    expect(res).toMatchObject({ ok: false, aborted: true });
    await waitDead(pid);
    expect(alive(pid)).toBe(false);
  });

  it('a hard timeout stops a run that never answers', async () => {
    process.env.FAKE_MODE = 'hang';
    process.env.FAKE_PID_FILE = join(dir, 'pid');
    const { run } = baseRun({ timeoutMs: 500 });
    const res = await runCodex(run);
    expect(res).toEqual({ ok: false, message: 'Codex took too long and was stopped.' });
    await waitDead(Number(readFileSync(join(dir, 'pid'), 'utf8')));
  });
});
