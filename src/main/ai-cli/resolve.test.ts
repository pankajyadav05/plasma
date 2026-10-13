import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type ResolveDeps, commonDirs, launchSpec, resolveBinary } from './resolve';

function deps(
  files: string[],
  over: Partial<ResolveDeps> = {},
): ResolveDeps & { shellCalls: string[] } {
  const shellCalls: string[] = [];
  return {
    platform: 'linux',
    env: { PATH: '/usr/bin:/opt/bin' },
    home: '/home/u',
    isExecutable: (p) => files.includes(p),
    loginShellLookup: async (n) => {
      shellCalls.push(n);
      return null;
    },
    shellCalls,
    ...over,
  };
}

describe('resolveBinary order', () => {
  it('a path typed in Settings wins, and is not searched for', async () => {
    const d = deps(['/custom/codex', '/usr/bin/codex']);
    expect(await resolveBinary('codex', '/custom/codex', d)).toEqual({
      path: '/custom/codex',
      source: 'override',
    });
    expect(d.shellCalls).toEqual([]);
  });

  it('a wrong override is not silently replaced by another program', async () => {
    const d = deps(['/usr/bin/codex']);
    expect(await resolveBinary('codex', '/nope/codex', d)).toBeNull();
  });

  it('an override that is not called codex / claude is refused, as is the wrong program', async () => {
    const d = deps(['/x/bash', '/x/claude', '/x/codex.exe']);
    expect(await resolveBinary('codex', '/x/bash', d)).toBeNull();
    expect(await resolveBinary('codex', '/x/claude', d)).toBeNull();
    expect((await resolveBinary('codex', '/x/codex.exe', d))?.source).toBe('override');
  });

  it('then PATH, in order', async () => {
    const d = deps(['/opt/bin/claude', '/usr/bin/claude']);
    expect(await resolveBinary('claude', '', d)).toEqual({
      path: '/usr/bin/claude',
      source: 'path',
    });
    expect(d.shellCalls).toEqual([]);
  });

  it('then the login shell, only when PATH has nothing', async () => {
    const d = deps(['/home/u/.nvm/bin/codex'], {
      loginShellLookup: async () => '/home/u/.nvm/bin/codex',
    });
    expect(await resolveBinary('codex', undefined, d)).toEqual({
      path: '/home/u/.nvm/bin/codex',
      source: 'login-shell',
    });
  });

  it('ignores a login shell answer that is not a runnable file', async () => {
    const d = deps([], { loginShellLookup: async () => '/ghost/codex' });
    expect(await resolveBinary('codex', undefined, d)).toBeNull();
  });

  it('then the usual install folders', async () => {
    const d = deps(['/home/u/.local/bin/claude']);
    expect(await resolveBinary('claude', undefined, d)).toEqual({
      path: '/home/u/.local/bin/claude',
      source: 'common',
    });
    expect(d.shellCalls).toEqual(['claude']);
    const mac = deps(['/opt/homebrew/bin/codex']);
    expect((await resolveBinary('codex', undefined, mac))?.path).toBe('/opt/homebrew/bin/codex');
  });

  it('is null when nothing is found', async () => {
    expect(await resolveBinary('codex', undefined, deps([]))).toBeNull();
  });

  it('on Windows tries .exe / .cmd on PATH and in %APPDATA%\\npm, and never asks a shell', async () => {
    const d = deps([], {
      platform: 'win32',
      env: { PATH: 'C:\\Windows', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
      home: 'C:\\Users\\u',
      isExecutable: (p) => p.toLowerCase().endsWith(join('npm', 'codex.cmd')),
    });
    const r = await resolveBinary('codex', undefined, d);
    expect(r?.source).toBe('common');
    expect(r?.path.toLowerCase()).toContain('codex.cmd');
    expect(d.shellCalls).toEqual([]);
  });
});

describe('commonDirs', () => {
  it('lists the folders the spec names', () => {
    const dirs = commonDirs({ platform: 'linux', env: {}, home: '/h' });
    expect(dirs).toEqual(
      expect.arrayContaining(['/h/.local/bin', '/opt/homebrew/bin', '/usr/local/bin']),
    );
  });
});

describe('launchSpec', () => {
  it('starts a normal file as is', () => {
    expect(launchSpec('/usr/bin/codex', ['a'], 'linux')).toEqual({
      command: '/usr/bin/codex',
      args: ['a'],
    });
    expect(launchSpec('C:\\x\\codex.exe', ['a'], 'win32')).toEqual({
      command: 'C:\\x\\codex.exe',
      args: ['a'],
    });
  });

  it('reads the script an npm .cmd shim points at and starts node on it', () => {
    const shim =
      '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n';
    expect(launchSpec('C:\\npm\\codex.cmd', ['app-server'], 'win32', () => shim)).toEqual({
      command: 'node',
      args: ['C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js', 'app-server'],
    });
  });

  it('falls back to the file itself when the shim cannot be read', () => {
    expect(
      launchSpec('C:\\npm\\codex.cmd', ['x'], 'win32', () => {
        throw new Error('nope');
      }),
    ).toEqual({ command: 'C:\\npm\\codex.cmd', args: ['x'] });
  });
});
