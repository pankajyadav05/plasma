import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchAction } from '@shared/deep-link';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LaunchRouter } from './launch';

let dir: string;
let sent: LaunchAction[];
let logs: string[];
let opened: string[];
let sqliteAllowed: string[];
let importAllowed: string[];
let confirm: boolean;
let confirmed: string[];
let sendOk: boolean;
let focused: number;

function router() {
  return new LaunchRouter({
    confirmWorkspace: async (p) => {
      confirmed.push(p);
      return confirm;
    },
    openWorkspace: (p) => opened.push(p),
    allowSqlitePath: (p) => sqliteAllowed.push(p),
    sqliteFileProblem: (p) => (p.endsWith('.bad') ? 'That file is not a SQLite database.' : null),
    allowImportPath: (p) => importAllowed.push(p),
    send: (a) => {
      if (sendOk) sent.push(a);
      return sendOk;
    },
    focusWindow: () => {
      focused++;
    },
    log: (m) => logs.push(m),
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plasma-launch-'));
  sent = [];
  logs = [];
  opened = [];
  sqliteAllowed = [];
  importAllowed = [];
  confirmed = [];
  confirm = true;
  sendOk = true;
  focused = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const connectLink = (url: string, extra = '') =>
  `plasma://connect?url=${encodeURIComponent(url)}${extra}`;

describe('second-instance argv', () => {
  it('forwards a protocol launch to the renderer once it is ready', async () => {
    const r = router();
    r.takePending();
    await r.handleArgv(['/opt/plasma/plasma', '--no-sandbox', connectLink('postgres://u:p@h/db')]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'connect', prefill: { host: 'h', password: 'p' } });
    expect(focused).toBeGreaterThan(0);
  });

  it('queues actions that arrive before the renderer is listening', async () => {
    const r = router();
    await r.handleArgv([
      'plasma',
      connectLink('postgres://u@h1/db'),
      connectLink('mysql://u@h2/db'),
    ]);
    expect(sent).toEqual([]);
    const pending = r.takePending();
    expect(pending.map((a) => (a.kind === 'connect' ? a.prefill.host : ''))).toEqual(['h1', 'h2']);
    expect(r.takePending()).toEqual([]);
    await r.handleArgv(['plasma', connectLink('redis://h3')]);
    expect(sent).toHaveLength(1);
  });

  it('queues again when the window goes away or cannot receive', async () => {
    const r = router();
    r.takePending();
    r.rendererGone();
    await r.handleArgv(['plasma', connectLink('postgres://u@h/db')]);
    expect(r.takePending()).toHaveLength(1);
    sendOk = false;
    await r.handleArgv(['plasma', connectLink('postgres://u@h/db')]);
    expect(r.takePending()).toHaveLength(1);
  });

  it('ignores arguments that are not ours', async () => {
    const r = router();
    r.takePending();
    await r.handleArgv(['plasma', '--inspect', 'file.sql', 'https://example.com']);
    expect(sent).toEqual([]);
    expect(opened).toEqual([]);
  });

  it('reports an invalid link instead of acting on it', async () => {
    const r = router();
    r.takePending();
    await r.handleArgv(['plasma', connectLink('ftp://h/x')]);
    expect(sent).toEqual([
      { kind: 'error', message: expect.stringMatching(/Unsupported URL scheme/) },
    ]);
  });
});

describe('logging', () => {
  it('never logs a password', async () => {
    const r = router();
    r.takePending();
    await r.handleUrl(connectLink('postgres://app:SuperSecret1@h/db'));
    expect(logs.join('\n')).not.toContain('SuperSecret1');
    expect(JSON.stringify(logs)).not.toContain('SuperSecret1');
  });
});

describe('plasma://open?workspace', () => {
  const url = (p: string) => `plasma://open?workspace=${encodeURIComponent(p)}`;

  it('asks first and opens only when confirmed', async () => {
    const r = router();
    r.takePending();
    await r.handleUrl(url(dir));
    expect(confirmed).toEqual([dir]);
    expect(opened).toEqual([dir]);
    expect(sent).toEqual([{ kind: 'workspace' }]);
  });

  it('does nothing when the user declines', async () => {
    confirm = false;
    const r = router();
    r.takePending();
    await r.handleUrl(url(dir));
    expect(opened).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('reports a missing folder', async () => {
    const r = router();
    r.takePending();
    await r.handleUrl(url(join(dir, 'nope')));
    expect(opened).toEqual([]);
    expect(sent[0]).toMatchObject({ kind: 'error' });
  });
});

describe('launcher flags (plasma open / import)', () => {
  it('opens a connection url as a pre-filled dialog', async () => {
    const r = router();
    r.takePending();
    await r.handleArgv(['plasma', '--plasma-open=postgres://u:p@h:5/db']);
    expect(sent[0]).toMatchObject({ kind: 'connect', prefill: { port: 5, user: 'u' } });
  });

  it('opens a folder as a workspace without a prompt', async () => {
    const r = router();
    r.takePending();
    await r.handleArgv(['plasma', `--plasma-open=${dir}`]);
    expect(confirmed).toEqual([]);
    expect(opened).toEqual([dir]);
  });

  it('opens a sqlite file: allowlists that one path and pre-fills', async () => {
    const file = join(dir, 'app.sqlite');
    writeFileSync(file, '');
    const r = router();
    r.takePending();
    await r.handleArgv(['plasma', `--plasma-open=${file}`]);
    expect(sqliteAllowed).toEqual([file]);
    expect(sent[0]).toMatchObject({
      kind: 'connect',
      prefill: { engine: 'sqlite', database: file },
    });
  });

  it('resolves a relative path against the second instance cwd', async () => {
    mkdirSync(join(dir, 'proj'));
    const r = router();
    r.takePending();
    await r.handleArgv(['plasma', '--plasma-open=proj'], dir);
    expect(opened).toEqual([join(dir, 'proj')]);
  });

  it('refuses a file that is not a database, and a missing path', async () => {
    const bad = join(dir, 'x.bad');
    writeFileSync(bad, 'x');
    const r = router();
    r.takePending();
    await r.handleArgv(['plasma', `--plasma-open=${bad}`, `--plasma-open=${join(dir, 'gone')}`]);
    expect(sqliteAllowed).toEqual([]);
    expect(sent[0]).toMatchObject({ kind: 'error' });
  });

  it('prepares the import dialog: allowlists the file, validates the table', async () => {
    const csv = join(dir, 'people.csv');
    writeFileSync(csv, 'a,b\n1,2\n');
    const r = router();
    r.takePending();
    await r.handleArgv([
      'plasma',
      `--plasma-import=${csv}`,
      '--plasma-into=postgres://u:p@h/db',
      '--plasma-table=staging.people',
    ]);
    expect(importAllowed).toEqual([csv]);
    expect(sent[0]).toMatchObject({
      kind: 'import',
      file: { path: csv, name: 'people.csv', format: 'csv' },
      into: { host: 'h', password: 'p' },
      schema: 'staging',
      table: 'people',
    });
  });

  it('rejects a bad table name, bad url or unreadable file before allowlisting anything', async () => {
    const csv = join(dir, 'p.csv');
    writeFileSync(csv, 'a\n1\n');
    const r = router();
    r.takePending();
    await r.handleArgv([
      'plasma',
      `--plasma-import=${csv}`,
      '--plasma-into=postgres://h/db',
      '--plasma-table=a;drop',
    ]);
    await r.handleArgv([
      'plasma',
      `--plasma-import=${csv}`,
      '--plasma-into=ftp://h/db',
      '--plasma-table=t',
    ]);
    await r.handleArgv([
      'plasma',
      `--plasma-import=${join(dir, 'nope.csv')}`,
      '--plasma-into=postgres://h/db',
      '--plasma-table=t',
    ]);
    expect(importAllowed).toEqual([]);
    expect(sent.map((a) => a.kind)).toEqual(['error', 'error', 'error']);
  });
});
