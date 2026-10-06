import { describe, expect, it } from 'vitest';
import {
  AI_IMAGE_REMOVED_TEXT,
  AI_MAX_IMAGE_DATA_URL,
  type AiContent,
  capHistoryImages,
  contentText,
  countImages,
  isAiImageDataUrl,
} from './ai-images';
import { AiChatRequest, AiMessage } from './protocol';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const img = (url = PNG) => ({ type: 'image_url' as const, image_url: { url } });
const user = (content: AiContent) => ({ role: 'user' as const, content });

describe('image data URLs', () => {
  it('accepts base64 png, jpeg, webp and gif', () => {
    for (const t of ['png', 'jpeg', 'webp', 'gif']) {
      expect(isAiImageDataUrl(`data:image/${t};base64,AAAA`)).toBe(true);
    }
  });

  it('rejects remote URLs, other types and malformed data', () => {
    expect(isAiImageDataUrl('https://example.com/a.png')).toBe(false);
    expect(isAiImageDataUrl('http://example.com/a.png')).toBe(false);
    expect(isAiImageDataUrl('file:///etc/passwd')).toBe(false);
    expect(isAiImageDataUrl('data:image/svg+xml;base64,AAAA')).toBe(false);
    expect(isAiImageDataUrl('data:text/html;base64,AAAA')).toBe(false);
    expect(isAiImageDataUrl('data:image/png;base64,')).toBe(false);
    expect(isAiImageDataUrl('data:image/png;base64,AA AA')).toBe(false);
    expect(isAiImageDataUrl('data:image/png,AAAA')).toBe(false);
  });

  it('rejects an image string over the size limit', () => {
    const big = `data:image/png;base64,${'A'.repeat(AI_MAX_IMAGE_DATA_URL)}`;
    expect(isAiImageDataUrl(big)).toBe(false);
    expect(AiMessage.safeParse(user([img(big)])).success).toBe(false);
  });
});

describe('AiMessage / AiChatRequest limits', () => {
  it('keeps plain string content working', () => {
    expect(AiMessage.parse({ role: 'user', content: 'hi' }).content).toBe('hi');
  });

  it('accepts text and image parts', () => {
    const m = AiMessage.parse(user([img(), { type: 'text', text: 'what is this' }]));
    expect(countImages(m.content)).toBe(1);
  });

  it('rejects a remote image URL and a foreign mime type', () => {
    expect(AiMessage.safeParse(user([img('https://x.test/a.png')])).success).toBe(false);
    expect(AiMessage.safeParse(user([img('data:image/svg+xml;base64,AAAA')])).success).toBe(false);
  });

  it('allows 6 images per message and not 7', () => {
    expect(AiMessage.safeParse(user(Array.from({ length: 6 }, () => img()))).success).toBe(true);
    expect(AiMessage.safeParse(user(Array.from({ length: 7 }, () => img()))).success).toBe(false);
  });

  it('keeps images to user messages', () => {
    expect(AiMessage.safeParse({ role: 'assistant', content: [img()] }).success).toBe(false);
  });

  it('allows 12 images in a request and not 13', () => {
    const msgs = (n: number) =>
      Array.from({ length: n / 3 }, () => user(Array.from({ length: 3 }, () => img())));
    expect(AiChatRequest.safeParse({ requestId: 'r', messages: msgs(12) }).success).toBe(true);
    expect(AiChatRequest.safeParse({ requestId: 'r', messages: msgs(15) }).success).toBe(false);
  });
});

describe('capHistoryImages', () => {
  it('leaves a conversation within the cap alone', () => {
    const ms = [user([img(), img()]), { role: 'assistant' as const, content: 'ok' }];
    expect(capHistoryImages(ms, 12)).toEqual(ms);
  });

  it('drops the oldest images first and leaves a marker', () => {
    const a = user([img('data:image/png;base64,AAAA'), { type: 'text', text: 'one' }]);
    const b = user([img('data:image/png;base64,BBBB'), img('data:image/png;base64,CCCC')]);
    const out = capHistoryImages([a, b], 2);
    expect(out[0]?.content).toEqual([
      { type: 'text', text: AI_IMAGE_REMOVED_TEXT },
      { type: 'text', text: 'one' },
    ]);
    expect(countImages(out[1]?.content ?? '')).toBe(2);
    // The input is not mutated.
    expect(countImages(a.content)).toBe(1);
  });

  it('caps to 12 by default', () => {
    const ms = Array.from({ length: 4 }, () => user([img(), img(), img(), img()]));
    const out = capHistoryImages(ms);
    expect(out.reduce((n, m) => n + countImages(m.content), 0)).toBe(12);
    expect(contentText(out[0]?.content ?? '')).toContain(AI_IMAGE_REMOVED_TEXT);
  });
});
