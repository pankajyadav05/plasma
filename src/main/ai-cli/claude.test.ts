import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildClaudeArgs,
  claudeEnv,
  claudeMcpConfig,
  claudeUserLine,
  createClaudeParser,
  redactCliMessage,
  runClaude,
} from './claude';
import { FAKE_CLI as FAKE, alive, unsetEnv, waitDead } from './test-util';
import { createToolEndpoint } from './tool-endpoint';
import type { CliRun } from './types';

describe('buildClaudeArgs', () => {
  const args = buildClaudeArgs({
    model: 'haiku',
    systemPromptPath: '/tmp/sys.txt',
    mcpConfigPath: '/tmp/cfg.json',
    hasTools: true,
  });
  const arg = (flag: string) => args[args.indexOf(flag) + 1];

  it('turns every built-in tool off and trusts nothing from disk', () => {
    expect(args).toContain('-p');
    expect(arg('--tools')).toBe('');
    expect(args).toContain('--strict-mcp-config');
    expect(arg('--setting-sources')).toBe('');
    expect(args).toContain('--no-session-persistence');
    expect(arg('--input-format')).toBe('stream-json');
    expect(arg('--output-format')).toBe('stream-json');
    expect(args).toContain('--include-partial-messages');
  });

  it('passes the system prompt, model and the MCP config path', () => {
    expect(arg('--system-prompt-file')).toBe('/tmp/sys.txt');
    // The prompt itself is never on argv (length limit on Windows, visible in `ps`).
    expect(args).not.toContain('--system-prompt');
    expect(args).not.toContain('SYS');
    expect(args).toContain('--disable-slash-commands');
    expect(arg('--model')).toBe('haiku');
    expect(arg('--mcp-config')).toBe('/tmp/cfg.json');
  });

  it('--effort only when an effort is chosen', () => {
    expect(args).not.toContain('--effort');
    const withEffort = buildClaudeArgs({
      model: 'claude-haiku-5-5',
      systemPromptPath: '/s',
      mcpConfigPath: '/c',
      hasTools: false,
      effort: 'high',
    });
    expect(withEffort[withEffort.indexOf('--effort') + 1]).toBe('high');
    expect(withEffort[withEffort.indexOf('--model') + 1]).toBe('claude-haiku-5-5');
  });

  it('pre-approves only the plasma server, and only when there are tools', () => {
    expect(arg('--allowedTools')).toBe('mcp__plasma_chat');
    const none = buildClaudeArgs({
      model: 'm',
      systemPromptPath: 's',
      mcpConfigPath: 'p',
      hasTools: false,
    });
    expect(none).not.toContain('--allowedTools');
  });

  it('never carries the bearer token on argv', () => {
    const cfg = claudeMcpConfig({ url: 'http://127.0.0.1:1/mcp', token: 'SECRET-TOKEN' });
    expect(args.join(' ')).not.toContain('SECRET-TOKEN');
    expect(JSON.parse(cfg).mcpServers.plasma_chat).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:1/mcp',
      headers: { Authorization: 'Bearer SECRET-TOKEN' },
    });
    expect(JSON.parse(claudeMcpConfig(null))).toEqual({ mcpServers: {} });
  });
});

describe('claudeEnv', () => {
  it('drops ELECTRON_RUN_AS_NODE and PLASMA_* and switches auto memory off', () => {
    process.env.ELECTRON_RUN_AS_NODE = '1';
    process.env.PLASMA_SECRET_THING = 'x';
    try {
      const env = claudeEnv();
      expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
      expect(env.PLASMA_SECRET_THING).toBeUndefined();
      expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      unsetEnv('ELECTRON_RUN_AS_NODE', 'PLASMA_SECRET_THING');
    }
  });
});

describe('claudeUserLine', () => {
  it('puts the text first and images as base64 blocks', () => {
    const line = claudeUserLine('hi', [{ mediaType: 'image/png', data: 'AAA' }]);
    expect(line).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
        ],
      },
    });
  });
});

const L = (o: unknown) => JSON.stringify(o);
const delta = (text: string, parent: string | null = null) =>
  L({
    type: 'stream_event',
    parent_tool_use_id: parent,
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  });

describe('createClaudeParser', () => {
  it('reads init: the plasma server connected, foreign tools counted', () => {
    const parse = createClaudeParser();
    expect(
      parse(
        L({
          type: 'system',
          subtype: 'init',
          tools: ['mcp__plasma_chat__run_query', 'Bash'],
          mcp_servers: [{ name: 'plasma_chat', status: 'connected' }],
        }),
      ),
    ).toEqual([{ kind: 'init', plasmaConnected: true, foreignTools: 1 }]);
    expect(parse(L({ type: 'system', subtype: 'init', tools: [], mcp_servers: [] }))).toEqual([
      { kind: 'init', plasmaConnected: null, foreignTools: 0 },
    ]);
    expect(
      parse(
        L({
          type: 'system',
          subtype: 'init',
          tools: [],
          mcp_servers: [{ name: 'plasma_chat', status: 'failed' }],
        }),
      ),
    ).toEqual([{ kind: 'init', plasmaConnected: false, foreignTools: 0 }]);
  });

  it('streams text deltas of the main conversation only', () => {
    const parse = createClaudeParser();
    expect(parse(delta('pong'))).toEqual([{ kind: 'delta', text: 'pong' }]);
    expect(parse(delta('SUB', 'toolu_1'))).toEqual([]);
  });

  it('ignores the repeated full assistant message and other lines', () => {
    const parse = createClaudeParser();
    expect(
      parse(L({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } })),
    ).toEqual([]);
    expect(parse(L({ type: 'system', subtype: 'status' }))).toEqual([]);
    expect(parse('not json')).toEqual([]);
    expect(parse('42')).toEqual([]);
  });

  it('separates the text of a later message from the one before it', () => {
    const parse = createClaudeParser();
    const start = L({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'message_start' },
    });
    expect(parse(start)).toEqual([]);
    expect(parse(delta('Looking.'))).toHaveLength(1);
    expect(parse(start)).toEqual([{ kind: 'delta', text: '\n' }]);
    expect(parse(delta('Done.'))).toHaveLength(1);
    // Already ends in a newline: nothing added.
    expect(parse(delta('\n'))).toHaveLength(1);
    expect(parse(start)).toEqual([]);
  });

  it('maps the result line', () => {
    const parse = createClaudeParser();
    expect(parse(L({ type: 'result', is_error: false, subtype: 'success', result: 'ok' }))).toEqual(
      [{ kind: 'result', isError: false, text: 'ok', subtype: 'success' }],
    );
    expect(parse(L({ type: 'result', is_error: true, subtype: 'error_during_execution' }))).toEqual(
      [{ kind: 'result', isError: true, text: '', subtype: 'error_during_execution' }],
    );
  });

  it('maps rate limits: allowed passes, anything else is a readable block', () => {
    const parse = createClaudeParser();
    const ok = parse(
      L({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1 } }),
    );
    expect(ok[0]).toMatchObject({ kind: 'rate-limit', blocked: false });
    const warn = parse(
      L({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } }),
    );
    expect(warn[0]).toMatchObject({ blocked: false });
    const resetsAt = Math.floor(new Date(2030, 0, 2, 14, 0, 0).getTime() / 1000);
    const blocked = parse(
      L({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt } }),
    );
    expect(blocked[0]).toMatchObject({ kind: 'rate-limit', blocked: true });
    expect((blocked[0] as { message: string }).message).toMatch(
      /^Your Claude plan's limit is reached until .*14:00\.$/,
    );
  });
});

describe('redactCliMessage', () => {
  it('hides tokens and keys and caps the length', () => {
    expect(redactCliMessage('bad Bearer abcdef0123456789 here')).toBe('bad Bearer [redacted] here');
    expect(redactCliMessage('key sk-abcdefghijklmnop1234')).toBe('key [redacted]');
    expect(redactCliMessage('x'.repeat(5000))).toHaveLength(600);
  });
});

describe('runClaude with a fake CLI', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plasma-claude-test-'));
  });
  afterEach(() => {
    unsetEnv('FAKE_MODE', 'FAKE_PID_FILE', 'FAKE_SYS_OUT');
    rmSync(dir, { recursive: true, force: true });
  });

  function baseRun(
    over: Partial<CliRun> = {},
    tokenUrl: { url: string; token: string } | null = null,
  ) {
    const mcpConfigPath = join(dir, 'mcp.json');
    writeFileSync(mcpConfigPath, claudeMcpConfig(tokenUrl), { mode: 0o600 });
    const systemPromptPath = join(dir, 'system.txt');
    writeFileSync(systemPromptPath, 'the system prompt', { mode: 0o600 });
    const deltas: string[] = [];
    const run: CliRun = {
      launch: { command: process.execPath, args: [FAKE, 'claude'] },
      cwd: dir,
      model: 'haiku',
      system: 'the system prompt',
      systemPromptPath,
      prompt: 'hi',
      images: [],
      endpoint: tokenUrl,
      mcpConfigPath,
      onDelta: (t) => deltas.push(t),
      signal: new AbortController().signal,
      timeoutMs: 20_000,
      ...over,
    };
    return { run, deltas };
  }

  it('hands the system prompt over as a file with the same text', async () => {
    process.env.FAKE_SYS_OUT = join(dir, 'seen.txt');
    const { run } = baseRun();
    expect(await runClaude(run)).toEqual({ ok: true });
    expect(readFileSync(join(dir, 'seen.txt'), 'utf8')).toBe('the system prompt');
  });

  it('streams the main conversation text and finishes ok', async () => {
    const { run, deltas } = baseRun();
    const res = await runClaude(run);
    expect(res).toEqual({ ok: true });
    expect(deltas.join('')).toBe('hello');
  });

  it('runs a tool call through the endpoint and sees its answer', async () => {
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
      expect(await runClaude(run)).toEqual({ ok: true });
      expect(calls).toEqual(['query_database:{"sql":"select 1"}']);
      const text = deltas.join('');
      expect(text).toContain('hel');
      expect(text).toContain('tool:200:');
      expect(text).toContain('{\\"rows\\":[1]}');
      // The second message starts on its own line.
      expect(text).toContain('hel\n');
    } finally {
      reg.revoke();
      await endpoint.close();
    }
  });

  it('refuses to run when Claude Code starts with tools of its own', async () => {
    process.env.FAKE_MODE = 'foreign';
    const endpoint = createToolEndpoint();
    const reg = await endpoint.register({ tools: [], call: async () => '' });
    try {
      const { run } = baseRun({}, { url: reg.url, token: reg.token });
      const res = await runClaude(run);
      expect(res).toMatchObject({ ok: false });
      expect((res as { message: string }).message).toMatch(/own tools enabled/);
    } finally {
      reg.revoke();
      await endpoint.close();
    }
  });

  it('refuses when the plasma server is not connected', async () => {
    // A config with no server: the fake reports no mcp_servers although tools are expected.
    const { run } = baseRun({ endpoint: { url: 'http://127.0.0.1:1/mcp', token: 't' } });
    const res = await runClaude(run);
    expect(res).toMatchObject({ ok: false });
    expect((res as { message: string }).message).toMatch(/could not connect to Plasma/);
  });

  it('says plainly when the user is not signed in', async () => {
    process.env.FAKE_MODE = 'auth';
    const { run } = baseRun();
    const res = await runClaude(run);
    expect(res).toEqual({
      ok: false,
      message: 'Not signed in to Claude Code. Run `claude` in a terminal and sign in.',
    });
  });

  it('reports a program that is not there', async () => {
    const { run } = baseRun({ launch: { command: join(dir, 'nope'), args: [] } });
    expect(await runClaude(run)).toEqual({ ok: false, message: 'Claude Code is not installed.' });
  });

  it('Stop kills the process and leaves nothing behind', async () => {
    process.env.FAKE_MODE = 'hang';
    process.env.FAKE_PID_FILE = join(dir, 'pid');
    const ctl = new AbortController();
    const { run, deltas } = baseRun({ signal: ctl.signal });
    const p = runClaude(run);
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
    const { run } = baseRun({ timeoutMs: 400 });
    const res = await runClaude(run);
    expect(res).toEqual({ ok: false, message: 'Claude Code took too long and was stopped.' });
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
    await waitDead(pid);
    expect(alive(pid)).toBe(false);
    expect(existsSync(join(dir, 'pid'))).toBe(true);
  });
});

describe('unsafe model and effort values', () => {
  const base = { systemPromptPath: '/s', mcpConfigPath: '/c', hasTools: false };
  it('buildClaudeArgs refuses anything that could be read as a flag', () => {
    expect(() => buildClaudeArgs({ ...base, model: '--dangerously-skip-permissions' })).toThrow();
    expect(() => buildClaudeArgs({ ...base, model: '-x' })).toThrow();
    expect(() => buildClaudeArgs({ ...base, model: 'a b' })).toThrow();
    expect(() => buildClaudeArgs({ ...base, model: 'haiku', effort: '--x' })).toThrow();
    expect(() => buildClaudeArgs({ ...base, model: 'claude-opus-4-6[1m]' })).not.toThrow();
  });

  it('runClaude answers with a plain message instead of starting the program', async () => {
    const run: CliRun = {
      launch: { command: '/definitely/not/here', args: [] },
      cwd: tmpdir(),
      model: '--evil',
      system: '',
      prompt: 'hi',
      images: [],
      endpoint: null,
      onDelta: () => undefined,
      signal: new AbortController().signal,
    };
    const r = await runClaude(run);
    expect(r).toMatchObject({ ok: false });
    expect((r as { message: string }).message).toMatch(/cannot be used/);
  });
});
