import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SupportBundlePreview, SupportChannel } from '@shared/support-bundle';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The support bundle end to end in main: real log files on disk with secrets
 * and SQL in them, the IPC handlers registered, the preview read back, and the
 * zip written and opened by the system's unzip. Electron is replaced by a few
 * fakes that record what the handlers are asked.
 */

const root = mkdtempSync(join(tmpdir(), 'plasma-support-ipc-'));
const userData = join(root, 'userData');
const handlers = new Map<string, (...args: unknown[]) => unknown>();
let savePath: string | null = null;
let dialogCalls = 0;

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? userData : join(root, name)),
    getName: () => 'Plasma',
    getVersion: () => '3.3.0',
    getLocale: () => 'en-US',
    isPackaged: true,
  },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
  dialog: {
    showSaveDialog: async () => {
      dialogCalls++;
      return savePath ? { canceled: false, filePath: savePath } : { canceled: true };
    },
  },
}));
vi.mock('./logger', () => ({ logger: { info: () => undefined, error: () => undefined } }));

const { registerSupportIpc } = await import('./support-ipc');
const { workerOutput } = await import('./line-ring');

const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> =>
  (await handlers.get(channel)?.({}, ...args)) as T;

beforeAll(() => {
  mkdirSync(join(userData, 'logs'), { recursive: true });
  writeFileSync(
    join(userData, 'logs', 'main.log'),
    [
      '[2026-10-07 09:00:00.000] [info] started',
      '[2026-10-07 09:00:01.000] [error] connect failed postgres://alice:hunter2-pw@db.example.com/orders',
      "[2026-10-07 09:00:02.000] [error] bad statement SELECT ssn FROM people WHERE name = 'carol'",
      '[2026-10-07 09:00:03.000] [info] done',
    ].join('\n'),
  );
  writeFileSync(join(userData, 'logs', 'update-helper.log'), 'helper step 1\nhelper step 2\n');
  workerOutput.push('worker says hello\n', '[worker] ');
  registerSupportIpc({
    window: () => null,
    active: () => ({ engine: 'postgres', serverVersion: 'PostgreSQL 16.2' }),
    connections: () => [
      {
        id: 'c1',
        name: 'Prod',
        engine: 'postgres',
        host: 'db.example.com',
        port: 5432,
        database: 'orders',
        user: 'alice',
        password: 'hunter2-pw',
      },
    ],
    settings: () => ({
      theme: 'dark',
      openrouterApiKey: 'sk-or-v1-0123456789abcdef0123456789abcdef',
      snippets: [{ body: 'SELECT secret FROM vault' }],
    }),
  });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
  savePath = null;
  dialogCalls = 0;
});

describe('support bundle IPC', () => {
  it('previews real files without a secret or any SQL, with the app and the active connection', async () => {
    const preview = await invoke<SupportBundlePreview>(SupportChannel.Preview, {
      redactHostsAndUsers: false,
    });
    const text = preview.files.map((f) => f.text).join('\n');
    for (const bad of ['hunter2-pw', 'sk-or-v1', 'SELECT ssn', 'SELECT secret']) {
      expect(text, bad).not.toContain(bad);
    }
    const by = Object.fromEntries(preview.files.map((f) => [f.name, f.text]));
    expect(JSON.parse(by['system.json'] as string)).toMatchObject({
      app: { version: '3.3.0', packaged: true },
      activeConnection: { engine: 'postgres', serverVersion: 'PostgreSQL 16.2' },
    });
    expect(by['logs/main.log']).toContain('started');
    expect(by['logs/worker.log']).toContain('[worker] worker says hello');
    expect(by['logs/update-helper.log']).toContain('helper step 2');
    expect(by['errors.txt']).toContain('connect failed');
    expect(by['connections.json']).toContain('db.example.com');
    expect(preview.totalBytes).toBe(preview.files.reduce((n, f) => n + f.bytes, 0));
  });

  it('hides host names and user names when asked', async () => {
    const preview = await invoke<SupportBundlePreview>(SupportChannel.Preview, {
      redactHostsAndUsers: true,
    });
    const text = preview.files.map((f) => f.text).join('\n');
    expect(text).not.toContain('db.example.com');
    expect(text).not.toContain('alice');
    expect(text).toMatch(/host-\d/);
  });

  it('rejects options it does not understand', async () => {
    await expect(invoke(SupportChannel.Preview, { redactHostsAndUsers: 'yes' })).rejects.toThrow();
    await expect(invoke(SupportChannel.Preview, undefined)).rejects.toThrow();
  });

  it('saves a zip whose files are exactly the previewed text, and asks where first', async () => {
    const preview = await invoke<SupportBundlePreview>(SupportChannel.Preview, {
      redactHostsAndUsers: false,
    });
    savePath = join(root, 'out', 'bundle.zip');
    mkdirSync(join(root, 'out'), { recursive: true });
    const res = await invoke<{ saved: boolean; filePath?: string; bytes?: number }>(
      SupportChannel.Save,
      preview.token,
      { redactHostsAndUsers: false },
    );
    expect(dialogCalls).toBe(1);
    expect(res).toMatchObject({ saved: true, filePath: savePath });
    expect(existsSync(savePath)).toBe(true);
    expect(readFileSync(savePath).length).toBe(res.bytes);
    try {
      expect(execFileSync('unzip', ['-t', savePath], { encoding: 'utf8' })).toMatch(
        /No errors detected/,
      );
      for (const f of preview.files) {
        const out = execFileSync('unzip', ['-p', savePath, f.name], { encoding: 'utf8' });
        expect(out, f.name).toBe(f.text);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; // no unzip here
    }
  });

  it('writes nothing when the save dialog is cancelled', async () => {
    const preview = await invoke<SupportBundlePreview>(SupportChannel.Preview, {
      redactHostsAndUsers: false,
    });
    savePath = null;
    expect(
      await invoke(SupportChannel.Save, preview.token, { redactHostsAndUsers: false }),
    ).toEqual({ saved: false });
  });

  it('refuses a token that is not the preview on screen', async () => {
    const first = await invoke<SupportBundlePreview>(SupportChannel.Preview, {
      redactHostsAndUsers: false,
    });
    await invoke<SupportBundlePreview>(SupportChannel.Preview, { redactHostsAndUsers: true });
    savePath = join(root, 'x.zip');
    await expect(
      invoke(SupportChannel.Save, first.token, { redactHostsAndUsers: false }),
    ).rejects.toThrow(/out of date/);
    expect(dialogCalls).toBe(0);
    await expect(invoke(SupportChannel.Save, 42, { redactHostsAndUsers: false })).rejects.toThrow();
  });

  it('refuses to save when the setting on screen is not the one the files were made with', async () => {
    const shown = await invoke<SupportBundlePreview>(SupportChannel.Preview, {
      redactHostsAndUsers: false,
    });
    savePath = join(root, 'y.zip');
    await expect(
      invoke(SupportChannel.Save, shown.token, { redactHostsAndUsers: true }),
    ).rejects.toThrow(/not the ones/);
    expect(dialogCalls).toBe(0);
  });
});
