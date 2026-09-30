import { describe, expect, it } from 'vitest';
import { takeLines } from './pg-admin';

describe('takeLines', () => {
  it('keeps the unfinished tail for the next chunk', () => {
    const a = takeLines('', 'one\ntwo\nthr');
    expect(a).toEqual({ lines: ['one', 'two'], rest: 'thr' });
    const b = takeLines(a.rest, 'ee\r\nfour\n');
    expect(b).toEqual({ lines: ['three', 'four'], rest: '' });
  });
});
