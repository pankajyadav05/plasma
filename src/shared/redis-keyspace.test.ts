import { describe, expect, it } from 'vitest';
import {
  flagsWithKeyevents,
  isKeyeventPattern,
  keyeventPattern,
  keyeventsEnabled,
  parseKeyeventChannel,
  parseNotifyConfigReply,
} from './redis-keyspace';

describe('redis keyspace helpers', () => {
  it('builds and recognises the keyevent pattern', () => {
    expect(keyeventPattern(3)).toBe('__keyevent@3__:*');
    expect(isKeyeventPattern('__keyevent@3__:*')).toBe(true);
    expect(isKeyeventPattern('__keyevent@3__:set')).toBe(false);
    expect(isKeyeventPattern('news:*')).toBe(false);
  });

  it('parses event channels', () => {
    expect(parseKeyeventChannel('__keyevent@2__:expired')).toEqual({ db: 2, event: 'expired' });
    expect(parseKeyeventChannel('news')).toBeNull();
  });

  it('reads CONFIG GET replies of every shape', () => {
    expect(parseNotifyConfigReply(['notify-keyspace-events', 'KEA'])).toBe('KEA');
    expect(parseNotifyConfigReply(['notify-keyspace-events', ''])).toBe('');
    expect(parseNotifyConfigReply({ 'notify-keyspace-events': 'Ex' })).toBe('Ex');
    expect(parseNotifyConfigReply([])).toBeNull();
    expect(parseNotifyConfigReply(null)).toBeNull();
  });

  it('knows when keyevents are published', () => {
    expect(keyeventsEnabled('')).toBe(false);
    expect(keyeventsEnabled(null)).toBe(false);
    expect(keyeventsEnabled('KEA')).toBe(true);
    expect(keyeventsEnabled('Ex')).toBe(true);
    expect(keyeventsEnabled('K$')).toBe(false); // keyspace channels only
    expect(keyeventsEnabled('E')).toBe(false); // no event class
  });

  it('adds what is missing and keeps what is there', () => {
    expect(flagsWithKeyevents('')).toBe('EA');
    expect(flagsWithKeyevents(null)).toBe('EA');
    expect(flagsWithKeyevents('K$')).toBe('K$E');
    expect(flagsWithKeyevents('Ex')).toBe('Ex');
    expect(flagsWithKeyevents('KEA')).toBe('KEA');
  });
});
