import type { AiChatRequest } from '@shared/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { cancelAiChat, setAiToolExecutor, startAiChat, submitAiActionResult } from './ai';
import { createToolEndpoint } from './ai-cli/tool-endpoint';
import type { CliRun, CliRunResult } from './ai-cli/types';

type Evt = { kind: string; [k: string]: unknown };

function fakeWindow() {
  const events: Evt[] = [];
  const win = {
    isDestroyed: () => false,
    webContents: { send: (_ch: string, evt: Evt) => events.push(evt) },
  };
  return { win: win as never, events };
}

const req = (id: string, extra: Partial<AiChatRequest> = {}): AiChatRequest => ({
  requestId: id,
  messages: [{ role: 'user', content: 'hello' }],
  engine: 'postgres',
  ...extra,
});

async function rpc(run: CliRun, body: unknown, token = run.endpoint?.token) {
  const res = await fetch(run.endpoint?.url as string, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
const listTools = async (run: CliRun) =>
  (
    (await rpc(run, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json.result.tools as Array<{
      name: string;
    }>
  ).map((t) => t.name);
const callTool = (run: CliRun, name: string, args: unknown, id = 2) =>
  rpc(run, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const textOf = (r: { json: { result?: { content: Array<{ text: string }> } } }) =>
  r.json.result?.content[0]?.text ?? '';

const found = {
  platform: 'linux' as const,
  env: { PATH: '/bin' },
  home: '/h',
  isExecutable: (p: string) => p === '/bin/codex' || p === '/bin/claude',
  loginShellLookup: async () => null,
};

describe('CLI providers through startAiChat', () => {
  let endpoint = createToolEndpoint();
  let runs: CliRun[] = [];

  beforeEach(() => {
    endpoint = createToolEndpoint();
    runs = [];
  });
  afterEach(async () => {
    setAiToolExecutor(null);
    await endpoint.close();
  });

  /** Starts a chat; `script` plays the part of the CLI and decides how it ends. */
  async function start(
    id: string,
    extra: Partial<AiChatRequest>,
    options: Record<string, unknown>,
    script: (run: CliRun) => Promise<CliRunResult> = async () => ({ ok: true }),
    provider: 'codex' | 'claude-code' = 'codex',
  ) {
    const { win, events } = fakeWindow();
    const finished = new Promise<void>((resolve) => {
      (win as { webContents: { send: (c: string, e: Evt) => void } }).webContents.send = (
        _c: string,
        evt: Evt,
      ) => {
        events.push(evt);
        if (evt.kind === 'done' || evt.kind === 'error') resolve();
      };
    });
    const accepted = await startAiChat(win, req(id, extra), '', 'unused', {
      provider,
      cli: {
        model: 'm1',
        binaryOverride: '',
        userData: '/tmp/plasma-ai-cli-test',
        appVersion: '1.2.3',
      },
      cliDeps: {
        endpoint,
        resolve: found,
        runner: async (_p, run) => {
          runs.push(run);
          return script(run);
        },
      },
      ...options,
    });
    return { accepted, events, finished };
  }

  it('needs no API key and streams the CLI`s text as deltas, then done', async () => {
    const { accepted, events, finished } = await start('c1', {}, {}, async (run) => {
      run.onDelta('Hel');
      run.onDelta('lo');
      return { ok: true };
    });
    expect(accepted).toEqual({ accepted: true });
    await finished;
    expect(events).toEqual([
      { kind: 'delta', requestId: 'c1', text: 'Hel' },
      { kind: 'delta', requestId: 'c1', text: 'lo' },
      { kind: 'done', requestId: 'c1' },
    ]);
    expect(runs[0]?.model).toBe('m1');
    expect(runs[0]?.appVersion).toBe('1.2.3');
  });

  it('rejects a CLI provider that has no CLI settings', async () => {
    const { win } = fakeWindow();
    const r = await startAiChat(win, req('c0'), '', '', { provider: 'codex' });
    expect(r.accepted).toBe(false);
  });

  it('a plain chat without row data offers no tools and no endpoint', async () => {
    const { finished } = await start('c2', {}, {});
    await finished;
    expect(runs[0]?.endpoint).toBeNull();
    expect(endpoint.size()).toBe(0);
  });

  it('tools/list is exactly the set pump would offer', async () => {
    let names: string[] = [];
    const { finished } = await start(
      'c3',
      { agent: true },
      {
        allowRowData: true,
        memoryTools: {
          checkRemember: () => null,
          resolveForget: () => ({ ok: false, error: 'x' }),
        },
      },
      async (run) => {
        names = await listTools(run);
        return { ok: true };
      },
    );
    await finished;
    expect(names).toEqual([
      'show_table',
      'run_query',
      'propose_change',
      'open_in_editor',
      'remember',
      'forget',
      'query_database',
    ]);
  });

  it('offers only query_database to a plain chat with row data allowed', async () => {
    let names: string[] = [];
    const { finished } = await start('c4', {}, { allowRowData: true }, async (run) => {
      names = await listTools(run);
      return { ok: true };
    });
    await finished;
    expect(names).toEqual(['query_database']);
  });

  it('a one-shot task gets its own prompt and never any tools', async () => {
    const { finished } = await start(
      'c5',
      { task: 'nl-filter', agent: true },
      { allowRowData: true },
    );
    await finished;
    expect(runs[0]?.endpoint).toBeNull();
    expect(runs[0]?.system.length).toBeGreaterThan(20);
    expect(runs[0]?.prompt).toBe('hello');
  });

  it('runs row-data tools through the same executor and toolGuard as pump', async () => {
    const executed: Array<[string, unknown]> = [];
    setAiToolExecutor(async (name, args) => {
      executed.push([name, args]);
      return '{"rows":[1]}';
    });
    let guard: string | null = null;
    const out: string[] = [];
    const { finished } = await start(
      'c6',
      {},
      { allowRowData: true, toolGuard: () => guard },
      async (run) => {
        out.push(textOf(await callTool(run, 'query_database', { sql: 'select 1' })));
        guard = 'row-data access is not enabled for this connection';
        out.push(textOf(await callTool(run, 'query_database', { sql: 'select 2' }, 3)));
        return { ok: true };
      },
    );
    await finished;
    expect(executed).toEqual([['query_database', { sql: 'select 1' }]]);
    expect(out).toEqual([
      '{"rows":[1]}',
      '{"error":"rejected: row-data access is not enabled for this connection"}',
    ]);
  });

  it('shows an action card, waits for the user, and returns the shaped answer', async () => {
    const out: string[] = [];
    const { events, finished } = await start(
      'c7',
      { agent: true },
      { shapeActionResult: (res) => `shaped:${res.outcome}` },
      async (run) => {
        const pending = callTool(run, 'run_query', { sql: 'select 1', title: 'T' });
        for (let i = 0; i < 100 && !runs[0]; i++) await new Promise((r) => setTimeout(r, 10));
        await vi.waitFor(() => expect(events.some((e) => e.kind === 'action')).toBe(true));
        const card = events.find((e) => e.kind === 'action') as Evt;
        expect(card).toMatchObject({ name: 'run_query', args: { sql: 'select 1', title: 'T' } });
        submitAiActionResult({ requestId: 'c7', callId: card.callId, outcome: 'applied' });
        out.push(textOf(await pending));
        return { ok: true };
      },
    );
    await finished;
    expect(out).toEqual(['shaped:applied']);
  });

  it('the actionGuard stops a card before it is shown', async () => {
    const out: string[] = [];
    const { events, finished } = await start(
      'c8',
      { agent: true },
      { actionGuard: () => 'the active connection changed since this chat started' },
      async (run) => {
        out.push(textOf(await callTool(run, 'run_query', { sql: 'select 1' })));
        return { ok: true };
      },
    );
    await finished;
    expect(events.some((e) => e.kind === 'action')).toBe(false);
    expect(out[0]).toContain('rejected: the active connection changed');
  });

  it('a bad action is answered to the model, not shown to the user', async () => {
    const out: string[] = [];
    const { events, finished } = await start('c9', { agent: true }, {}, async (run) => {
      out.push(textOf(await callTool(run, 'run_query', { sql: 'delete from t' })));
      return { ok: true };
    });
    await finished;
    expect(events.some((e) => e.kind === 'action')).toBe(false);
    expect(out[0]).toContain('rejected');
  });

  it('SC-05: a tool nobody offered is unknown and never runs (query_database without the row-data opt-in)', async () => {
    const executed: string[] = [];
    setAiToolExecutor(async (name) => {
      executed.push(name);
      return 'x';
    });
    const out: string[] = [];
    const second = await start('c10', { agent: true }, {}, async (run) => {
      const r = await callTool(run, 'query_database', { sql: 'select 1' });
      out.push(r.json.error?.message ?? '');
      return { ok: true };
    });
    await second.finished;
    expect(out[0]).toMatch(/Unknown tool: query_database/);
    expect(executed).toEqual([]);
  });

  it('stops answering tool calls past the round cap', async () => {
    setAiToolExecutor(async () => '{"rows":[]}');
    const out: string[] = [];
    const { finished } = await start('c11', {}, { allowRowData: true }, async (run) => {
      // A plain chat allows 5 rounds.
      for (let i = 0; i < 7; i++) {
        out.push(textOf(await callTool(run, 'query_database', { sql: `select ${i}` }, 10 + i)));
      }
      return { ok: true };
    });
    await finished;
    expect(out.slice(0, 5).every((t) => t === '{"rows":[]}')).toBe(true);
    expect(out[5]).toMatch(/too many tool calls/);
    expect(out[6]).toMatch(/too many tool calls/);
  });

  it('the agent gets a longer cap than a plain chat', async () => {
    setAiToolExecutor(async () => '{"rows":[]}');
    const out: string[] = [];
    const { finished } = await start(
      'c12',
      { agent: true },
      { allowRowData: true },
      async (run) => {
        for (let i = 0; i < 9; i++) {
          out.push(textOf(await callTool(run, 'query_database', { sql: `select ${i}` }, 10 + i)));
        }
        return { ok: true };
      },
    );
    await finished;
    expect(out.slice(0, 8).every((t) => t === '{"rows":[]}')).toBe(true);
    expect(out[8]).toMatch(/too many tool calls/);
  });

  it('revokes the token when the run ends', async () => {
    let seen: CliRun | undefined;
    const { finished } = await start('c13', {}, { allowRowData: true }, async (run) => {
      seen = run;
      return { ok: true };
    });
    await finished;
    await vi.waitFor(() => expect(endpoint.size()).toBe(0));
    await expect(
      rpc(seen as CliRun, { jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    ).rejects.toBeTruthy();
  });

  it('revokes the token when the run errors', async () => {
    const { events, finished } = await start('c14', {}, { allowRowData: true }, async () => ({
      ok: false,
      message: 'Your Claude plan`s limit is reached until 14:00.',
    }));
    await finished;
    expect(events.at(-1)).toEqual({
      kind: 'error',
      requestId: 'c14',
      message: 'Your Claude plan`s limit is reached until 14:00.',
    });
    await vi.waitFor(() => expect(endpoint.size()).toBe(0));
  });

  it('Stop aborts the run, answers a waiting card as cancelled, revokes, and sends no done or error', async () => {
    let sawAbort = false;
    let scriptDone: () => void = () => undefined;
    const ended = new Promise<void>((r) => {
      scriptDone = r;
    });
    const { events } = await start('c15', { agent: true }, {}, async (run) => {
      const pending = callTool(run, 'run_query', { sql: 'select 1' });
      await new Promise<void>((resolve) => {
        run.signal.addEventListener('abort', () => {
          sawAbort = true;
          resolve();
        });
        void vi
          .waitFor(() => expect(events.some((e) => e.kind === 'action')).toBe(true))
          .then(() => {
            cancelAiChat('c15');
          });
      });
      const answer = await pending.catch(() => undefined);
      scriptDone();
      // The waiting card was answered as cancelled, so the call came back.
      expect(answer && textOf(answer)).toContain('cancelled');
      return { ok: false, aborted: true, message: '' };
    });
    await ended;
    await vi.waitFor(() => expect(endpoint.size()).toBe(0));
    expect(sawAbort).toBe(true);
    expect(events.some((e) => e.kind === 'done' || e.kind === 'error')).toBe(false);
  });

  it('says plainly when the program is not installed', async () => {
    const { win, events } = fakeWindow();
    const finished = new Promise<void>((resolve) => {
      (win as { webContents: { send: (c: string, e: Evt) => void } }).webContents.send = (
        _c,
        evt,
      ) => {
        events.push(evt);
        resolve();
      };
    });
    await startAiChat(win, req('c16'), '', '', {
      provider: 'claude-code',
      cli: { model: 'sonnet', binaryOverride: '', userData: '/tmp/x', appVersion: '1' },
      cliDeps: { endpoint, resolve: { ...found, isExecutable: () => false } },
    });
    await finished;
    expect(events[0]).toMatchObject({ kind: 'error', requestId: 'c16' });
    expect(events[0]?.message).toMatch(/Claude Code is not installed/);
  });

  it('sends the history as a transcript ahead of the latest message, images from the latest only', async () => {
    const png = 'data:image/png;base64,AAAA';
    const { finished } = await start(
      'c17',
      {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'first' },
              { type: 'image_url', image_url: { url: png } },
            ],
          },
          { role: 'assistant', content: 'answer one' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'second' },
              { type: 'image_url', image_url: { url: png } },
            ],
          },
        ],
      },
      {},
    );
    await finished;
    const run = runs[0] as CliRun;
    expect(run.prompt).toContain('User: first [1 image not repeated]');
    expect(run.prompt).toContain('Assistant: answer one');
    expect(run.prompt.endsWith('second')).toBe(true);
    expect(run.images).toEqual([{ mediaType: 'image/png', data: 'AAAA', url: png }]);
  });

  it('sends the system prompt as the system prompt, not inside the transcript', async () => {
    const { finished } = await start(
      'c18',
      { agent: true },
      { allowRowData: false },
      undefined,
      'claude-code',
    );
    await finished;
    const run = runs[0] as CliRun;
    expect(run.system).toMatch(/Plasma/);
    expect(run.prompt).toBe('hello');
    expect(run.prompt).not.toContain(run.system.slice(0, 40));
  });

  it('ignores the OpenRouter model the renderer may send: the CLI setting decides', async () => {
    const { finished } = await start('c19', { model: 'anthropic/claude-sonnet-5.5' }, {});
    await finished;
    expect(runs[0]?.model).toBe('m1');
  });
});
