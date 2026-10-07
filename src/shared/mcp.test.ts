import { describe, expect, it } from 'vitest';
import {
  type McpSnippetInput,
  accessAtLeast,
  claudeCodeSnippet,
  cleanClientName,
  codexSnippet,
  cursorSnippet,
  effectiveAccess,
  maskToken,
  parseMcpPort,
  resolveConnectionRef,
  scrubKnown,
  stdioSnippet,
} from './mcp';

describe('access levels', () => {
  it('orders off < schema < read < propose', () => {
    expect(accessAtLeast('read', 'schema')).toBe(true);
    expect(accessAtLeast('schema', 'read')).toBe(false);
    expect(accessAtLeast('off', 'schema')).toBe(false);
    expect(accessAtLeast('propose', 'propose')).toBe(true);
  });
  it('defaults to off and never lets a read-only connection propose', () => {
    expect(effectiveAccess(undefined, false)).toBe('off');
    expect(effectiveAccess('propose', true)).toBe('read');
    expect(effectiveAccess('propose', false)).toBe('propose');
    expect(effectiveAccess('schema', true)).toBe('schema');
  });
});

describe('parseMcpPort', () => {
  it('accepts 1024..65535 only', () => {
    expect(parseMcpPort(47321)).toBe(47321);
    expect(parseMcpPort('8080')).toBe(8080);
    expect(parseMcpPort(1023)).toBeNull();
    expect(parseMcpPort(65536)).toBeNull();
    expect(parseMcpPort('abc')).toBeNull();
    expect(parseMcpPort('')).toBeNull();
    expect(parseMcpPort(80.5)).toBeNull();
  });
});

describe('resolveConnectionRef', () => {
  const list = [
    { id: 'a1', name: 'Shop' },
    { id: 'b2', name: 'Dup' },
    { id: 'c3', name: 'Dup' },
    { id: 'Shop', name: 'Other' },
  ];
  it('finds by id or exact name', () => {
    expect(resolveConnectionRef('a1', list)).toEqual({ ok: true, id: 'a1' });
    expect(resolveConnectionRef(' b2 ', list)).toEqual({ ok: true, id: 'b2' });
  });
  it('lets an id win over a name', () => {
    expect(resolveConnectionRef('Shop', list)).toEqual({ ok: true, id: 'Shop' });
  });
  it('lists ids when a name is ambiguous', () => {
    const r = resolveConnectionRef('Dup', list);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('b2, c3');
  });
  it('refuses unknown and missing refs', () => {
    expect(resolveConnectionRef('nope', list).ok).toBe(false);
    expect(resolveConnectionRef(undefined, list).ok).toBe(false);
    expect(resolveConnectionRef('', list).ok).toBe(false);
  });
});

describe('scrubKnown / cleanClientName', () => {
  it('removes host, user and password, longest first', () => {
    const out = scrubKnown('could not connect to db.internal.corp as svc_user (pw hunter22)', [
      'db.internal.corp',
      'svc_user',
      'hunter22',
      'ab',
      undefined,
    ]);
    expect(out).not.toMatch(/db\.internal|svc_user|hunter22/);
  });
  it('keeps client names short and plain', () => {
    expect(cleanClientName('Claude Code\n<b>x</b>')).toBe('Claude Code b x /b');
    expect(cleanClientName(undefined)).toBe('An AI tool');
    expect(cleanClientName('x'.repeat(100)).length).toBe(40);
  });
});

describe('snippets', () => {
  const input: McpSnippetInput = {
    port: 47321,
    token: 'TOK',
    setup: {
      platform: 'linux',
      command: '/usr/bin/plasma',
      args: ['mcp'],
      env: {},
      launcherInstalled: true,
    },
  };
  it('fills in port and token', () => {
    expect(claudeCodeSnippet(input)).toBe(
      'claude mcp add --transport http plasma http://127.0.0.1:47321/mcp --header "Authorization: Bearer TOK"',
    );
    expect(JSON.parse(cursorSnippet(input))).toEqual({
      mcpServers: {
        plasma: { url: 'http://127.0.0.1:47321/mcp', headers: { Authorization: 'Bearer TOK' } },
      },
    });
    expect(codexSnippet(input)).toContain('[mcp_servers.plasma]');
    expect(codexSnippet(input)).toContain('url = "http://127.0.0.1:47321/mcp"');
    expect(JSON.parse(stdioSnippet(input))).toEqual({
      mcpServers: { plasma: { command: '/usr/bin/plasma', args: ['mcp'] } },
    });
  });
  it('adds env only when needed', () => {
    const s = stdioSnippet({
      ...input,
      setup: { ...input.setup, env: { PLASMA_USER_DATA: '/x' } },
    });
    expect(JSON.parse(s).mcpServers.plasma.env).toEqual({ PLASMA_USER_DATA: '/x' });
  });
  it('masks the token', () => {
    expect(maskToken('abc')).not.toContain('abc');
    expect(maskToken('')).toBe('');
  });
});
