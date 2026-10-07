import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { NOT_RUNNING_MESSAGE, candidateUserDataDirs, pickUserDataDir, runBridge } from './bridge';
import { McpService } from './service';
import { fakeToolsDeps } from './test-support';

const dirs: string[] = [];
const services: McpService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.stop()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'plasma-bridge-'));
  dirs.push(d);
  return d;
};

async function runningPlasma() {
  const dir = tmp();
  const { deps } = fakeToolsDeps();
  const { audit: _a, ...tools } = deps;
  const s = new McpService({ userDataDir: dir, version: '1', tools, audit: () => undefined });
  services.push(s);
  await s.apply({ enabled: true, port: 0 as never });
  return { dir, s };
}

/** Feed `lines` to the bridge in-process and collect what it prints. */
async function drive(dir: string, lines: string[]): Promise<unknown[]> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let out = '';
  stdout.on('data', (c) => {
    out += c;
  });
  const done = runBridge({ userDataDir: dir, stdin, stdout });
  for (const l of lines) stdin.write(`${l}\n`);
  stdin.end();
  await done;
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const initialize = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'Claude Desktop', version: '1' },
  },
});

describe('stdio bridge (in process)', () => {
  it('round-trips requests and prints nothing for notifications', async () => {
    const { dir } = await runningPlasma();
    const out = (await drive(dir, [
      initialize,
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'list_connections', arguments: {} },
      }),
    ])) as Array<{
      id: number;
      result: { serverInfo: { name: string }; tools: unknown[]; content: Array<{ text: string }> };
    }>;
    expect(out.map((o) => o.id).sort()).toEqual([1, 2, 3]);
    expect(out.find((o) => o.id === 1)?.result.serverInfo.name).toBe('plasma');
    expect(out.find((o) => o.id === 2)?.result.tools.length).toBeGreaterThan(0);
    const listed = out.find((o) => o.id === 3)?.result.content[0]?.text ?? '[]';
    expect(JSON.parse(listed)[0].name).toBe('Shop');
  });

  it('answers every request with the open-Plasma error when it is not running', async () => {
    const dir = tmp();
    const out = (await drive(dir, [
      initialize,
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 'x', method: 'tools/list' }),
    ])) as Array<{ id: unknown; error: { message: string } }>;
    expect(out).toHaveLength(2);
    expect(out.map((o) => o.id)).toEqual([1, 'x']);
    for (const o of out) expect(o.error.message).toBe(NOT_RUNNING_MESSAGE);
  });

  it('is told when Plasma has stopped (stale port file)', async () => {
    const { dir, s } = await runningPlasma();
    await s.stop();
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ port: s.status().port || 1 }));
    const out = (await drive(dir, [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    ])) as Array<{ error: { message: string } }>;
    expect(out[0]?.error.message).toBe(NOT_RUNNING_MESSAGE);
  });

  it('reports a bad line as a parse error, and a wrong token plainly', async () => {
    const { dir } = await runningPlasma();
    const bad = (await drive(dir, ['{oops'])) as Array<{ error: { code: number } }>;
    expect(bad[0]?.error.code).toBe(-32700);
    writeFileSync(join(dir, 'mcp-token'), `${'Z'.repeat(43)}\n`);
    const refused = (await drive(dir, [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    ])) as Array<{ error: { message: string } }>;
    expect(refused[0]?.error.message).toMatch(/refused the token/);
  });

  it('starts a new session when Plasma forgot the old one', async () => {
    const { dir, s } = await runningPlasma();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const seen: Array<{ id: number }> = [];
    let buf = '';
    stdout.on('data', (c) => {
      buf += c;
      for (const l of buf.split('\n').slice(0, -1)) seen.push(JSON.parse(l));
      buf = buf.slice(buf.lastIndexOf('\n') + 1);
    });
    const done = runBridge({ userDataDir: dir, stdin, stdout });
    stdin.write(`${initialize}\n`);
    await new Promise((r) => setTimeout(r, 100));
    // Plasma restarts on the same port: sessions are gone.
    const { port } = s.status();
    await s.apply({ enabled: false, port });
    await s.apply({ enabled: true, port });
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    await new Promise((r) => setTimeout(r, 200));
    stdin.end();
    await done;
    expect(seen.map((o) => o.id)).toEqual([1, 2]);
  });
});

describe('user data location', () => {
  it('PLASMA_USER_DATA wins; otherwise the per-OS default', () => {
    expect(candidateUserDataDirs({ PLASMA_USER_DATA: '/x' }, 'linux')).toEqual(['/x']);
    expect(candidateUserDataDirs({ XDG_CONFIG_HOME: '/cfg' }, 'linux')).toEqual([
      '/cfg/Plasma',
      '/cfg/plasma',
    ]);
    expect(candidateUserDataDirs({ APPDATA: 'C:\\A' }, 'win32')[0]).toMatch(/Plasma$/);
    expect(candidateUserDataDirs({}, 'darwin')[0]).toMatch(/Library\/Application Support\/Plasma$/);
    expect(pickUserDataDir({ PLASMA_USER_DATA: '/x' }, 'linux')).toBe('/x');
  });
});

describe('stdio bridge (spawned with node)', () => {
  it('works as a real child process, with PLASMA_USER_DATA', async () => {
    const { dir } = await runningPlasma();
    // Plain-Node file, as electron-vite emits it; run with node.
    const script = join(tmp(), 'mcp-bridge.mjs');
    const source = readFileSync(fileURLToPath(new URL('./bridge.ts', import.meta.url)), 'utf8');
    writeFileSync(
      script,
      ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText,
    );
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, PLASMA_USER_DATA: dir, ELECTRON_RUN_AS_NODE: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => {
      out += c;
    });
    child.stdin.write(`${initialize}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`);
    child.stdin.end();
    const code = await new Promise<number | null>((r) => child.on('close', r));
    expect(code).toBe(0);
    const msgs = out
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(msgs.map((m) => m.id).sort()).toEqual([1, 2]);
  }, 20_000);
});
