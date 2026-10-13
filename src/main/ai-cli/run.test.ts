import { describe, expect, it } from 'vitest';
import { CLI_TRANSCRIPT_MAX_CHARS, buildCliPrompt } from './run';

describe('buildCliPrompt', () => {
  it('a single message is the prompt as is', () => {
    expect(buildCliPrompt([{ role: 'user', content: 'hi' }])).toEqual({ prompt: 'hi', images: [] });
  });

  it('system messages never go into the transcript', () => {
    const { prompt } = buildCliPrompt([
      { role: 'system', content: 'SECRET SYSTEM' },
      { role: 'user', content: 'hi' },
    ]);
    expect(prompt).toBe('hi');
  });

  it('earlier turns become a transcript, the latest user message comes last', () => {
    const { prompt } = buildCliPrompt([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'three' },
    ]);
    expect(prompt).toBe(
      "Conversation so far:\n\nUser: one\n\nAssistant: two\n\n---\nThe user's latest message (answer this one):\n\nthree",
    );
  });

  it('takes images from the latest user message only', () => {
    const url = 'data:image/jpeg;base64,QUJD';
    const r = buildCliPrompt([
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url } },
          { type: 'text', text: 'old' },
        ],
      },
      { role: 'assistant', content: 'ok' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'new' },
          { type: 'image_url', image_url: { url } },
        ],
      },
    ]);
    expect(r.images).toEqual([{ mediaType: 'image/jpeg', data: 'QUJD', url }]);
    expect(r.prompt).toContain('User: old [1 image not repeated]');
  });

  it('skips an image that is not a data URL', () => {
    const r = buildCliPrompt([
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'https://example.com/x.png' } }],
      },
    ]);
    expect(r.images).toEqual([]);
  });

  it('keeps the transcript bounded, newest turns first to survive', () => {
    const big = 'x'.repeat(CLI_TRANSCRIPT_MAX_CHARS);
    const { prompt } = buildCliPrompt([
      { role: 'user', content: `OLDEST ${big}` },
      { role: 'assistant', content: 'NEWEST-REPLY' },
      { role: 'user', content: 'now' },
    ]);
    expect(prompt).toContain('[earlier messages left out]');
    expect(prompt).not.toContain('OLDEST');
    expect(prompt).toContain('NEWEST-REPLY');
    expect(prompt.endsWith('now')).toBe(true);
  });
});
