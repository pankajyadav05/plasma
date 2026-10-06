import type { AiChatRequest } from '@shared/protocol';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { buildTaskMessages, startAiChat } from './ai';

type Evt = { kind: string; [k: string]: unknown };
type Body = {
  messages: Array<{
    role: string;
    content: string | Array<{ type: string; [k: string]: unknown }>;
  }>;
};

const URL_A = 'data:image/png;base64,AAAA';
const img = (url = URL_A) => ({ type: 'image_url' as const, image_url: { url } });

function ok(): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(
        enc.encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`,
        ),
      );
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
  return new Response(body, { status: 200 });
}

function harness(res: () => Response = ok) {
  const events: Evt[] = [];
  const win = {
    isDestroyed: () => false,
    webContents: { send: (_c: string, e: Evt) => events.push(e) },
  } as never;
  const bodies: Body[] = [];
  const fetchImpl = vi.fn(async (_u: unknown, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return res();
  }) as never;
  const settled = async () => {
    for (let i = 0; i < 400; i++) {
      if (events.some((e) => e.kind === 'done' || e.kind === 'error')) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('timed out');
  };
  return { win, events, bodies, fetchImpl, settled };
}

const req = (id: string, extra: Partial<AiChatRequest> = {}): AiChatRequest =>
  ({
    requestId: id,
    engine: 'postgres',
    messages: [{ role: 'user', content: [img(), { type: 'text', text: 'what is this?' }] }],
    ...extra,
  }) as never;

describe('images in messages (main)', () => {
  it('sends image parts to OpenRouter in the OpenAI shape', async () => {
    const h = harness();
    await startAiChat(h.win, req('i1'), 'k', 'm', { fetchImpl: h.fetchImpl });
    await h.settled();
    const user = h.bodies[0]?.messages.find((m) => m.role === 'user');
    expect(user?.content).toEqual([img(), { type: 'text', text: 'what is this?' }]);
  });

  it('sends the same parts to a local server, with no key', async () => {
    const h = harness();
    await startAiChat(h.win, req('i2'), '', 'm', {
      provider: 'local',
      localUrl: 'http://127.0.0.1:11434',
      localModel: 'llava',
      fetchImpl: h.fetchImpl,
    });
    await h.settled();
    const user = h.bodies[0]?.messages.find((m) => m.role === 'user');
    expect(user?.content).toEqual([img(), { type: 'text', text: 'what is this?' }]);
  });

  it('works in agent mode too', async () => {
    const h = harness();
    await startAiChat(h.win, req('i3', { agent: true }), 'k', 'm', { fetchImpl: h.fetchImpl });
    await h.settled();
    const user = h.bodies[0]?.messages.find((m) => m.role === 'user');
    expect(Array.isArray(user?.content)).toBe(true);
  });

  it('drops the oldest images beyond 12 and says so in text', async () => {
    const messages = Array.from({ length: 5 }, (_, i) => ({
      role: 'user' as const,
      content: [img(`data:image/png;base64,M${i}AA`), img(), img()],
    }));
    const h = harness();
    await startAiChat(h.win, req('i4', { messages } as never), 'k', 'm', {
      fetchImpl: h.fetchImpl,
    });
    await h.settled();
    const users = h.bodies[0]?.messages.filter((m) => m.role === 'user') ?? [];
    const parts = users.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
    expect(parts.filter((p) => p.type === 'image_url')).toHaveLength(12);
    expect(parts.filter((p) => p.text === '[image removed from history]')).toHaveLength(3);
    // The oldest message lost its images, the newest kept all of them.
    expect(JSON.stringify(users[0]?.content)).not.toContain('image_url');
    expect(JSON.stringify(users.at(-1)?.content)).toContain('image_url');
  });

  it('keeps tasks text-only', () => {
    const out = buildTaskMessages('fix-sql', [
      { role: 'user', content: [img(), { type: 'text', text: 'fix it' }] },
    ]);
    expect(out.at(-1)).toEqual({ role: 'user', content: 'fix it' });
  });

  it('does not put image data in the logs or events', async () => {
    const h = harness();
    await startAiChat(h.win, req('i5'), 'k', 'm', { fetchImpl: h.fetchImpl });
    await h.settled();
    expect(JSON.stringify(h.events)).not.toContain('base64');
  });

  it('hints that a local model may not support images when it errors', async () => {
    const h = harness(() => new Response('bad request', { status: 400 }));
    await startAiChat(h.win, req('i6'), '', 'm', {
      provider: 'local',
      localUrl: 'http://127.0.0.1:11434',
      localModel: 'llama3',
      fetchImpl: h.fetchImpl,
    });
    await h.settled();
    const err = h.events.find((e) => e.kind === 'error');
    expect(String(err?.message)).toContain('may not support images');
  });

  it('does not add the hint to a text-only message', async () => {
    const h = harness(() => new Response('bad request', { status: 400 }));
    await startAiChat(
      h.win,
      req('i7', { messages: [{ role: 'user', content: 'hi' }] } as never),
      '',
      'm',
      {
        provider: 'local',
        localUrl: 'http://127.0.0.1:11434',
        localModel: 'llama3',
        fetchImpl: h.fetchImpl,
      },
    );
    await h.settled();
    expect(String(h.events.find((e) => e.kind === 'error')?.message)).not.toContain('images');
  });
});
