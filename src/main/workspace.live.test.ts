/**
 * Live check that a workspace profile (env-interpolated, password from the
 * secret store) yields a config that really connects. Opt-in:
 *   PLASMA_LIVE_PG=postgres://user:pw@127.0.0.1:5501/postgres npx vitest run src/main/workspace.live.test.ts
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkspaceService } from './workspace';

const url = process.env.PLASMA_LIVE_PG;
const run = url ? describe : describe.skip;

run('workspace profile -> live Postgres', () => {
  let root: string;
  let ws: WorkspaceService;
  const secrets = new Map<string, string>();

  beforeAll(() => {
    const u = new URL(url as string);
    root = realpathSync(mkdtempSync(join(tmpdir(), 'plasma-wslive-')));
    mkdirSync(join(root, '.plasma'));
    writeFileSync(
      join(root, '.plasma', 'connections.json'),
      JSON.stringify({
        version: 1,
        connections: [
          {
            id: 'live',
            name: 'Live',
            engine: 'postgres',
            host: '${PGHOST}',
            port: '${PGPORT:-5432}',
            database: u.pathname.slice(1) || 'postgres',
            user: decodeURIComponent(u.username),
          },
        ],
      }),
    );
    ws = new WorkspaceService({
      env: { PGHOST: u.hostname, PGPORT: u.port },
      getSecret: (k) => secrets.get(k) ?? null,
      putSecret: (k, v) => (v ? secrets.set(k, v) : secrets.delete(k)),
      hasSecret: (k) => secrets.has(k),
      allowSqlitePath: () => undefined,
      onChange: () => undefined,
    });
    ws.open(root);
  });
  afterAll(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('prompts once, then connects with the stored password', async () => {
    expect(ws.profileConfig('live').needsPassword).toBe(true);
    ws.setPassword('live', decodeURIComponent(new URL(url as string).password));
    const { config, needsPassword } = ws.profileConfig('live');
    expect(needsPassword).toBe(false);
    const full = ws.connectConfig(config.id);
    const client = new pg.Client({
      host: full.host,
      port: full.port,
      database: full.database,
      user: full.user,
      password: full.password,
    });
    await client.connect();
    try {
      const r = await client.query('select 1 as ok');
      expect(r.rows[0]).toEqual({ ok: 1 });
    } finally {
      await client.end();
    }
  });
});
