import { describe, expect, it } from 'vitest';
import {
  droppedFromNotice,
  isJsonPayload,
  matchesTailFilter,
  prettyPayload,
  pushCapped,
} from './live-tail';

describe('pushCapped', () => {
  it('prepends and counts what falls off the cap', () => {
    expect(pushCapped([2, 1], 3, 5)).toEqual({ rows: [3, 2, 1], dropped: 0 });
    expect(pushCapped([3, 2, 1], 4, 3)).toEqual({ rows: [4, 3, 2], dropped: 1 });
  });
});

describe('droppedFromNotice', () => {
  it('reads both worker wordings and ignores real traffic', () => {
    expect(droppedFromNotice('(plasma)', '1,200 messages were dropped: x')).toBe(1200);
    expect(droppedFromNotice('(plasma)', '7 notifications were dropped: x')).toBe(7);
    expect(droppedFromNotice('orders', '7 messages were dropped')).toBe(0);
    expect(droppedFromNotice('(plasma)', 'The listener connection was lost.')).toBe(0);
  });
});

describe('matchesTailFilter', () => {
  it('matches channel and payload case-insensitively', () => {
    expect(matchesTailFilter('Orders', '{"id":1}', 'orders')).toBe(true);
    expect(matchesTailFilter('orders', '{"id":1}', '"id"')).toBe(true);
    expect(matchesTailFilter('orders', 'x', 'nope')).toBe(false);
    expect(matchesTailFilter('orders', 'x', '')).toBe(true);
  });
  it('scopes to a field and negates', () => {
    expect(matchesTailFilter('orders', 'paid', 'channel:paid')).toBe(false);
    expect(matchesTailFilter('orders', 'paid', 'payload:paid')).toBe(true);
    expect(matchesTailFilter('orders', 'paid', '!paid')).toBe(false);
    expect(matchesTailFilter('orders', 'paid', '!refund')).toBe(true);
  });
});

describe('payload helpers', () => {
  it('pretty-prints JSON only', () => {
    expect(prettyPayload('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyPayload('plain')).toBe('plain');
    expect(prettyPayload('{broken')).toBe('{broken');
    expect(isJsonPayload('[1,2]')).toBe(true);
    expect(isJsonPayload('{broken')).toBe(false);
  });
});
