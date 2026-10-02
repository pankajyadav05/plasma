import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { OpenSearchDriver, ResponseTooLargeError, readCappedText } from './opensearch';

describe('readCappedText (P2-14)', () => {
  it('reads a body under the cap', async () => {
    const body = Readable.from([Buffer.from('{"a":'), Buffer.from('1}')]);
    expect(await readCappedText(body, 1024)).toBe('{"a":1}');
  });

  it('gives up and destroys the stream past the cap', async () => {
    const body = Readable.from([Buffer.alloc(600), Buffer.alloc(600), Buffer.alloc(600)]);
    await expect(readCappedText(body, 1000)).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(body.destroyed).toBe(true);
  });

  it('names the narrowing options in the message', () => {
    expect(new ResponseTooLargeError(64 * 1024 * 1024).message).toMatch(
      /64 MB.*filter_path.*smaller size/,
    );
  });
});

describe('typed client calls are abortable (P2-14)', () => {
  it('disconnect aborts an in-flight overview request instead of leaving it dangling', async () => {
    const os = new OpenSearchDriver();
    let aborted = false;
    const hang = () => {
      const p = new Promise(() => undefined) as Promise<unknown> & { abort: () => void };
      p.abort = () => {
        aborted = true;
      };
      return p;
    };
    (os as unknown as { client: unknown }).client = {
      info: hang,
      close: async () => undefined,
      transport: { request: async () => ({ body: {} }) },
    };
    void os.overview().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 10));
    await os.disconnect();
    expect(aborted).toBe(true);
  });
});
