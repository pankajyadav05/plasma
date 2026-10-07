import { beforeEach, describe, expect, it, vi } from 'vitest';

const aiChat = vi.fn(async (_r: unknown) => ({ accepted: true }));

vi.mock('@/lib/ipc', () => ({
  ipc: {
    settings: { get: vi.fn(), set: vi.fn(async () => undefined) },
    vault: { list: vi.fn(async () => []) },
    history: { list: vi.fn(async () => []) },
    ai: {
      chat: (r: unknown) => aiChat(r),
      cancel: vi.fn(async () => undefined),
      actionResult: vi.fn(async () => undefined),
    },
  },
}));

import type { AiImage } from '@/lib/ai-images';
import { useSession } from './session';

const image = (n: number): AiImage => ({
  id: `i${n}`,
  name: `shot${n}.png`,
  size: 3,
  width: 10,
  height: 10,
  dataUrl: `data:image/png;base64,AAA${n}`,
});

type Sent = {
  messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
};
const sent = () => aiChat.mock.calls.at(-1)?.[0] as Sent;

beforeEach(() => {
  aiChat.mockClear();
  aiChat.mockResolvedValue({ accepted: true });
  useSession.setState({
    activeConfig: { id: 'c1', name: 'c', engine: 'redis' } as never,
    aiChat: [],
    aiActions: {},
    aiChatConnectionId: null,
    aiPending: false,
    aiRequestId: null,
  } as never);
});

describe('aiAsk with images', () => {
  it('sends images with the text and shows them on the user turn', async () => {
    const ok = await useSession.getState().aiAsk('what is this?', { images: [image(1), image(2)] });
    expect(ok).toBe(true);
    const user = sent().messages.at(-1);
    expect(user?.content).toEqual([
      { type: 'image_url', image_url: { url: image(1).dataUrl } },
      { type: 'image_url', image_url: { url: image(2).dataUrl } },
      { type: 'text', text: 'what is this?' },
    ]);
    const turn = useSession.getState().aiChat[0];
    expect(turn?.content).toBe('what is this?');
    expect(turn?.images).toHaveLength(2);
  });

  it('sends images alone, with no text part', async () => {
    const ok = await useSession.getState().aiAsk('   ', { images: [image(1)] });
    expect(ok).toBe(true);
    expect(sent().messages.at(-1)?.content).toEqual([
      { type: 'image_url', image_url: { url: image(1).dataUrl } },
    ]);
  });

  it('sends nothing for no text and no images', async () => {
    expect(await useSession.getState().aiAsk('  ')).toBe(false);
    expect(aiChat).not.toHaveBeenCalled();
  });

  it('keeps plain string content for text-only messages', async () => {
    await useSession.getState().aiAsk('hello');
    expect(sent().messages.at(-1)?.content).toBe('hello');
  });

  it('keeps earlier images in later turns, capped at 12 (oldest dropped)', async () => {
    const s = useSession.getState();
    for (let t = 0; t < 3; t++) {
      await s.aiAsk(`turn ${t}`, { images: Array.from({ length: 5 }, (_, i) => image(t * 5 + i)) });
      useSession.setState({ aiPending: false, aiRequestId: null });
    }
    const all = sent().messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
    expect(all.filter((p) => p.type === 'image_url')).toHaveLength(12);
    expect(all.filter((p) => p.text === '[image removed from history]')).toHaveLength(3);
  });

  it('reports a failed start so the caller keeps the draft', async () => {
    aiChat.mockRejectedValueOnce(new Error('boom'));
    const ok = await useSession.getState().aiAsk('x', { images: [image(1)] });
    expect(ok).toBe(false);
    expect(useSession.getState().aiPending).toBe(false);
    expect(useSession.getState().aiChat[1]?.error).toBe('boom');
  });

  it('reports a rejected request as not sent', async () => {
    aiChat.mockResolvedValueOnce({ accepted: false });
    expect(await useSession.getState().aiAsk('x', { images: [image(1)] })).toBe(false);
  });
});

describe('an MCP client proposes a change (external thread)', () => {
  it('opens a labelled thread bound to its connection and keeps it out of what the model sees', async () => {
    useSession.setState({ activeConfig: { id: 'c1', name: 'c', engine: 'postgres' } as never });
    useSession.getState().aiApplyEvent({
      kind: 'external',
      requestId: 'mcp-1',
      connectionId: 'c1',
      client: 'Claude Code',
    });
    const s = useSession.getState();
    expect(s.aiRequestId).toBe('mcp-1');
    expect(s.aiChatConnectionId).toBe('c1');
    expect(s.aiPending).toBe(true);
    expect(s.aiChat.map((t) => [t.role, t.content, Boolean(t.external)])).toEqual([
      ['user', 'Claude Code wants to change data', true],
      ['assistant', '', true],
    ]);
    // the event that follows is not a stale stream
    useSession.getState().aiApplyEvent({ kind: 'done', requestId: 'mcp-1' });
    expect(useSession.getState().aiPending).toBe(false);
    // the next question of the user does not carry the MCP thread to the model
    await useSession.getState().aiAsk('hello');
    const msgs = sent().messages;
    expect(msgs.map((m) => m.role)).toEqual(['user']);
  });

  it('starts fresh when the thread is for another connection', () => {
    useSession.setState({
      aiChat: [{ id: 'x', role: 'user', content: 'old', streaming: false }],
      aiChatConnectionId: 'other',
    } as never);
    useSession
      .getState()
      .aiApplyEvent({ kind: 'external', requestId: 'mcp-2', connectionId: 'c1', client: 'Cursor' });
    expect(useSession.getState().aiChat).toHaveLength(2);
  });
});
