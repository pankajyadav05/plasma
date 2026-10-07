import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { McpService } from './service';
import { fakeToolsDeps } from './test-support';

const dirs: string[] = [];
const services: McpService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.stop()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function make() {
  const dir = mkdtempSync(join(tmpdir(), 'plasma-mcp-'));
  dirs.push(dir);
  const { deps, audits } = fakeToolsDeps();
  const { audit: _a, ...tools } = deps;
  const written: unknown[] = [];
  const s = new McpService({
    userDataDir: dir,
    version: '1',
    tools,
    audit: (e) => written.push(e),
  });
  services.push(s);
  return { s, dir, audits, written };
}

const post = (port: number, token: string, body: unknown) =>
  fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('McpService', () => {
  it('is off by default: nothing listens, no token file', async () => {
    const { s, dir } = make();
    await s.apply({ enabled: false, port: 47999 });
    expect(s.status()).toMatchObject({ enabled: false, state: 'off', message: 'Off' });
    expect(existsSync(join(dir, 'mcp-token'))).toBe(false);
    expect(existsSync(join(dir, 'mcp.json'))).toBe(false);
  });

  it('listens, writes the port file, logs calls, and stops when disabled', async () => {
    const { s, dir, written } = make();
    await s.apply({ enabled: true, port: 0 as never });
    const st = s.status();
    expect(st.state).toBe('listening');
    expect(st.message).toBe(`Listening on 127.0.0.1:${st.port}`);
    expect(JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8')).port).toBe(st.port);
    const token = s.getToken();
    const r = await post(st.port, token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_connections' },
    });
    expect(r.status).toBe(200);
    expect(s.status().activity[0]).toMatchObject({ tool: 'list_connections', outcome: 'ok' });
    expect(written).toHaveLength(1);
    await s.apply({ enabled: false, port: st.port });
    expect(s.status().state).toBe('off');
    expect(existsSync(join(dir, 'mcp.json'))).toBe(false);
    await expect(post(st.port, token, {})).rejects.toBeTruthy();
  });

  it('says so when the port is taken, and does not move to another one', async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const taken = (blocker.address() as { port: number }).port;
    try {
      const { s } = make();
      await s.apply({ enabled: true, port: taken });
      expect(s.status().state).toBe('port-in-use');
      expect(s.status().message).toBe(`Port ${taken} is in use by another app`);
    } finally {
      blocker.close();
    }
  });

  it('a new token works at once and the old one stops', async () => {
    const { s } = make();
    await s.apply({ enabled: true, port: 0 as never });
    const port = s.status().port;
    const old = s.getToken();
    const fresh = s.rotateToken();
    expect(fresh).not.toBe(old);
    expect((await post(port, old, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
    expect((await post(port, fresh, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(200);
  });

  it('keeps only the last 50 calls, newest first', async () => {
    const { s } = make();
    await s.apply({ enabled: true, port: 0 as never });
    const { port } = s.status();
    const token = s.getToken();
    for (let i = 0; i < 55; i++) {
      await post(port, token, {
        jsonrpc: '2.0',
        id: i,
        method: 'tools/call',
        params: { name: 'list_connections' },
      });
    }
    const a = s.status().activity;
    expect(a).toHaveLength(50);
    expect(a[0]?.ts).toBeGreaterThanOrEqual(a[49]?.ts ?? 0);
  });
});
