import { describe, expect, it } from 'vitest';
import {
  classifyRedisCommand,
  isRedisReadCommand,
  redisCommandNeedsConfirm,
  tokenizeRedisCommand,
} from './redis-command-policy';

describe('classifyRedisCommand', () => {
  it('refuses subscriber and connection-state commands (R3)', () => {
    for (const c of [
      ['SUBSCRIBE', 'a'],
      ['psubscribe', 'a*'],
      ['MONITOR'],
      ['MULTI'],
      ['HELLO', '3'],
      ['AUTH', 'x'],
    ]) {
      expect(classifyRedisCommand(c).mode).toBe('refuse');
    }
    expect(classifyRedisCommand(['SUBSCRIBE', 'a']).reason).toMatch(/Pub\/sub/);
  });

  it('routes blocking commands to a dedicated connection', () => {
    expect(classifyRedisCommand(['BLPOP', 'q', '0']).mode).toBe('blocking');
    expect(classifyRedisCommand(['XREAD', 'BLOCK', '0', 'STREAMS', 's', '$']).mode).toBe(
      'blocking',
    );
    expect(classifyRedisCommand(['XREAD', 'STREAMS', 's', '0']).mode).toBe('shared');
  });

  it('flags destructive commands', () => {
    expect(classifyRedisCommand(['flushall']).risk).toBe('destructive');
    expect(classifyRedisCommand(['FLUSHDB', 'ASYNC']).risk).toBe('destructive');
    expect(classifyRedisCommand(['CONFIG', 'SET', 'maxmemory', '1']).risk).toBe('destructive');
    expect(classifyRedisCommand(['CONFIG', 'GET', 'maxmemory']).risk).toBe('normal');
    expect(classifyRedisCommand(['DEBUG', 'SLEEP', '1']).risk).toBe('destructive');
    expect(classifyRedisCommand(['SHUTDOWN']).risk).toBe('destructive');
    expect(classifyRedisCommand(['DEL', 'user:*']).reason).toMatch(/does not expand patterns/);
    expect(classifyRedisCommand(['DEL', 'a', 'b']).risk).toBe('destructive');
    expect(classifyRedisCommand(['DEL', 'a']).risk).toBe('normal');
    expect(classifyRedisCommand(['KEYS', '*']).risk).toBe('expensive');
    expect(classifyRedisCommand(['ACL', 'LOG']).risk).toBe('normal');
    expect(classifyRedisCommand(['ACL', 'LOG', 'RESET']).risk).toBe('destructive');
  });

  it('knows reads from writes, unknown = write', () => {
    expect(isRedisReadCommand(['GET', 'k'])).toBe(true);
    expect(isRedisReadCommand(['hgetall', 'k'])).toBe(true);
    expect(isRedisReadCommand(['CLIENT', 'LIST'])).toBe(true);
    expect(isRedisReadCommand(['CLIENT', 'KILL', 'ID', '1'])).toBe(false);
    expect(isRedisReadCommand(['SET', 'k', 'v'])).toBe(false);
    expect(isRedisReadCommand(['SOMEMODULE.CMD'])).toBe(false);
    expect(isRedisReadCommand(['SUBSCRIBE', 'x'])).toBe(false);
  });

  it('treats SELECT as a db switch', () => {
    expect(classifyRedisCommand(['select', '3']).mode).toBe('select');
  });
});

describe('redisCommandNeedsConfirm', () => {
  it('always confirms destructive/expensive, and every write on prod', () => {
    expect(redisCommandNeedsConfirm(classifyRedisCommand(['FLUSHDB']), false)).toBe(true);
    expect(redisCommandNeedsConfirm(classifyRedisCommand(['KEYS', '*']), false)).toBe(true);
    expect(redisCommandNeedsConfirm(classifyRedisCommand(['SET', 'a', 'b']), false)).toBe(false);
    expect(redisCommandNeedsConfirm(classifyRedisCommand(['SET', 'a', 'b']), true)).toBe(true);
    expect(redisCommandNeedsConfirm(classifyRedisCommand(['GET', 'a']), true)).toBe(false);
  });
});

describe('command-policy gaps (P2-11)', () => {
  it.each([
    ['SYNC'],
    ['PSYNC', '?', '-1'],
    ['READONLY'],
    ['READWRITE'],
    ['CLIENT', 'NO-TOUCH', 'on'],
    ['CLIENT', 'CACHING', 'yes'],
  ])('refuses %s', (...parts) => {
    expect(classifyRedisCommand(parts).mode).toBe('refuse');
    expect(isRedisReadCommand(parts)).toBe(false);
  });

  it.each([
    ['EVAL', 'return redis.call("FLUSHALL")', '0'],
    ['EVALSHA', 'abc', '0'],
    ['FCALL', 'f', '0'],
    ['SCRIPT', 'LOAD', 'return 1'],
    ['FUNCTION', 'LOAD', 'code'],
  ])('treats %s as a destructive write', (...parts) => {
    const v = classifyRedisCommand(parts);
    expect(v.access).toBe('write');
    expect(v.risk).toBe('destructive');
    expect(redisCommandNeedsConfirm(v, false)).toBe(true);
  });

  it('no longer treats TOUCH as a read; ordinary reads still are', () => {
    expect(isRedisReadCommand(['TOUCH', 'k'])).toBe(false);
    for (const cmd of [
      ['HVALS', 'h'],
      ['KEYS', '*'],
      ['LINDEX', 'l', '0'],
      ['XINFO', 'STREAM', 's'],
      ['JSON.GET', 'k'],
    ]) {
      expect(isRedisReadCommand(cmd)).toBe(true);
    }
  });
});

describe('tokenizeRedisCommand (R17)', () => {
  it('handles quotes, escapes and empty arguments', () => {
    expect(tokenizeRedisCommand('SET k ""')).toEqual(['SET', 'k', '']);
    expect(tokenizeRedisCommand("SET k ''")).toEqual(['SET', 'k', '']);
    expect(tokenizeRedisCommand('SET "a b" \'c d\'')).toEqual(['SET', 'a b', 'c d']);
    expect(tokenizeRedisCommand('SET k "line\\nnext \\"q\\" \\x41"')).toEqual([
      'SET',
      'k',
      'line\nnext "q" A',
    ]);
    expect(tokenizeRedisCommand("SET k 'it\\'s'")).toEqual(['SET', 'k', "it's"]);
    expect(tokenizeRedisCommand('  GET   k  ')).toEqual(['GET', 'k']);
    expect(tokenizeRedisCommand('SET k "open')).toBeNull();
  });
});
