import { describe, expect, it } from 'vitest';
import { LineRing } from './line-ring';

describe('LineRing', () => {
  it('keeps the newest lines up to its capacity', () => {
    const ring = new LineRing(3);
    ring.push('a\nb\nc\nd\ne\n');
    expect(ring.text()).toBe('c\nd\ne');
    expect(ring.size).toBe(3);
  });

  it('joins a line split across chunks and keeps a line still being written', () => {
    const ring = new LineRing(10);
    ring.push('first li');
    ring.push('ne\nsecond');
    expect(ring.text()).toBe('first line\nsecond');
    ring.push(' line\n');
    expect(ring.text()).toBe('first line\nsecond line');
  });

  it('tags lines with a prefix, accepts buffers and CRLF', () => {
    const ring = new LineRing(10);
    ring.push(Buffer.from('boom\r\nagain\r\n'), '[worker:err] ');
    expect(ring.text()).toBe('[worker:err] boom\n[worker:err] again');
  });

  it('does not grow without bound on a line that never ends', () => {
    const ring = new LineRing(10);
    ring.push('x'.repeat(20000));
    expect(ring.text().length).toBeLessThan(9000);
  });
});
