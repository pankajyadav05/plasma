import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CliInstallStatus, LaunchAction } from '@shared/deep-link';
import {
  WorkspaceChannel,
  type WorkspaceSnapshot,
  parseWorkspaceConnectionId,
} from '@shared/workspace';
import { BrowserWindow, app, dialog, ipcMain } from 'electron';
import { z } from 'zod';
import { installLauncher, installTargets, windowsInstructions } from './cli-install';
import { allowImportPath } from './import-ipc';
import { LaunchRouter } from './launch';
import { logger } from './logger';
import { allowSqlitePath, sqliteFileProblem } from './sqlite-files';
import { getSecret, hasSecret, putSecret } from './vault';
import { RecentWorkspaces, WorkspaceService } from './workspace';

/**
 * Electron side of D1 (workspaces), D2 (deep links) and the CLI companion:
 * IPC handlers, protocol registration and second-instance forwarding.
 */

const VariableValueSchema = z.object({
  mode: z.enum(['text', 'number', 'date', 'boolean', 'null', 'raw']),
  value: z.string().max(100_000),
});

const QueryWriteSchema = z.object({
  path: z.string().max(300).optional(),
  folder: z.string().max(300).optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  connection: z.string().max(100).optional(),
  variables: z.record(z.string().max(100), VariableValueSchema).default({}),
  sql: z.string().max(1_000_000),
  baseRev: z.string().nullable().optional(),
  overwrite: z.boolean().optional(),
});

const SnippetSchema = z.object({
  name: z.string().min(1).max(120),
  prefix: z.string().min(1).max(60),
  description: z.string().max(500),
  body: z.string().max(100_000),
});

const NotebookSchema = z.object({
  name: z.string().min(1).max(200),
  connection: z.string().max(100).optional(),
  cells: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        kind: z.enum(['sql', 'md']),
        content: z.string().max(500_000),
      }),
    )
    .max(500),
});

function str(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 4096)
    throw new Error(`Invalid ${what}`);
  return v;
}

export interface WorkspaceRuntime {
  workspace: WorkspaceService;
  launch: LaunchRouter;
  recents: RecentWorkspaces;
  /** Full connection config for a `ws:` id, or null when the id is not a workspace profile. */
  connectConfigFor(connectionId: string): ReturnType<WorkspaceService['connectConfig']> | null;
}

let runtime: WorkspaceRuntime | null = null;

export function workspaceRuntime(): WorkspaceRuntime {
  if (!runtime) throw new Error('workspace runtime is not initialised');
  return runtime;
}

function targetWindow(getWindow: () => BrowserWindow | null): BrowserWindow | null {
  const win = getWindow();
  return win && !win.isDestroyed() ? win : null;
}

/**
 * Create the workspace service and launch router. Safe to call before the app
 * is ready (nothing touches the vault or the disk until used).
 */
export function createWorkspaceRuntime(getWindow: () => BrowserWindow | null): WorkspaceRuntime {
  const recents = new RecentWorkspaces(join(app.getPath('userData'), 'recent-workspaces.json'));
  const send = (channel: string, payload: unknown): boolean => {
    const win = targetWindow(getWindow);
    if (!win || win.webContents.isLoading()) return false;
    win.webContents.send(channel, payload);
    return true;
  };

  const workspace: WorkspaceService = new WorkspaceService({
    env: process.env,
    getSecret: (k) => getSecret(k),
    putSecret: (k, v) => putSecret(k, v),
    hasSecret: (k) => hasSecret(k),
    allowSqlitePath,
    onChange: () => {
      if (workspace.isOpen) send(WorkspaceChannel.ChangedEvent, safeSnapshot(workspace));
    },
  });

  const launch = new LaunchRouter({
    confirmWorkspace: async (path) => {
      await app.whenReady();
      const win = targetWindow(getWindow);
      const opts = {
        type: 'question' as const,
        buttons: ['Open workspace', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Open workspace',
        message: 'A link wants to open a workspace folder in Plasma.',
        detail: `${path}\n\nOnly open folders you trust: a workspace can define connections and queries.`,
      };
      const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
      return r.response === 0;
    },
    openWorkspace: (path) => {
      const snap = workspace.open(path);
      recents.add(snap.root);
    },
    allowSqlitePath,
    sqliteFileProblem,
    allowImportPath,
    send: (action: LaunchAction) => send(WorkspaceChannel.LaunchEvent, action),
    focusWindow: () => {
      const win = targetWindow(getWindow);
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.focus();
    },
    log: (m) => logger.info(`[plasma] ${m}`),
  });

  runtime = {
    workspace,
    launch,
    recents,
    connectConfigFor: (id) => (parseWorkspaceConnectionId(id) ? workspace.connectConfig(id) : null),
  };
  return runtime;
}

function safeSnapshot(ws: WorkspaceService): WorkspaceSnapshot | null {
  try {
    return ws.snapshot();
  } catch (err) {
    logger.warn('[plasma] workspace snapshot failed', err);
    return null;
  }
}

/** Protocol registration, `open-url`, and single-instance argv forwarding. Call before `ready`. */
export function registerLaunchHandlers(rt: WorkspaceRuntime, hasLock: boolean): void {
  if (!hasLock) return;
  // Only a packaged build may claim plasma:// (a dev electron would hijack it).
  if (app.isPackaged || process.env.PLASMA_REGISTER_PROTOCOL === '1') {
    try {
      app.setAsDefaultProtocolClient('plasma');
    } catch (err) {
      logger.warn('[plasma] could not register plasma:// protocol', err);
    }
  }
  // macOS delivers links here, possibly before `ready`.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    void rt.launch.handleUrl(url).catch((err) => logger.error('[plasma] open-url failed', err));
  });
  // Windows / Linux: a link or the launcher starts a second instance with argv.
  app.on('second-instance', (_event, argv, workingDirectory) => {
    void rt.launch
      .handleArgv(argv, workingDirectory)
      .catch((err) => logger.error('[plasma] second-instance failed', err));
  });
}

/** First launch: handle links / flags in this process's own argv. */
export function handleStartupArgv(rt: WorkspaceRuntime): void {
  void rt.launch
    .handleArgv(process.argv.slice(1))
    .catch((err) => logger.error('[plasma] startup argv failed', err));
}

function scriptPath(): string {
  if (app.isPackaged) {
    return join(
      process.resourcesPath,
      'bin',
      process.platform === 'win32' ? 'plasma.cmd' : 'plasma',
    );
  }
  return join(app.getAppPath(), 'bin', process.platform === 'win32' ? 'plasma.cmd' : 'plasma');
}

function cliStatus(message?: string): CliInstallStatus {
  const platform = process.platform as CliInstallStatus['platform'];
  const script = scriptPath();
  let installedAt: string | null = null;
  if (platform !== 'win32') {
    for (const t of installTargets(homedir())) {
      const dest = join(t.dir, 'plasma');
      try {
        realpathSync(dest);
        installedAt = dest;
        break;
      } catch {
        // not installed there
      }
    }
  }
  return {
    platform,
    scriptPath: script,
    installedAt,
    instructions: platform === 'win32' ? windowsInstructions(script) : null,
    ...(message ? { message } : {}),
  };
}

export function registerWorkspaceIpc(
  rt: WorkspaceRuntime,
  getWindow: () => BrowserWindow | null,
): void {
  const { workspace, recents, launch } = rt;
  const openApproved = (path: string): WorkspaceSnapshot => {
    const snap = workspace.open(path);
    recents.add(snap.root);
    return snap;
  };

  ipcMain.handle(WorkspaceChannel.OpenDialog, async (): Promise<WorkspaceSnapshot | null> => {
    const win = targetWindow(getWindow);
    const opts = {
      title: 'Open workspace folder',
      properties: ['openDirectory' as const, 'createDirectory' as const],
    };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    const path = r.canceled ? undefined : r.filePaths[0];
    return path ? openApproved(path) : null;
  });

  ipcMain.handle(WorkspaceChannel.OpenRecent, (_e, raw: unknown): WorkspaceSnapshot | null => {
    const path = str(raw, 'path');
    // Only folders the user already approved once.
    if (!recents.has(path)) throw new Error('That folder is not in your recent workspaces');
    return openApproved(path);
  });

  ipcMain.handle(WorkspaceChannel.Close, (): void => {
    workspace.close();
  });
  ipcMain.handle(WorkspaceChannel.Current, (): WorkspaceSnapshot | null =>
    workspace.isOpen ? safeSnapshot(workspace) : null,
  );
  ipcMain.handle(WorkspaceChannel.Recents, () => recents.list());
  ipcMain.handle(WorkspaceChannel.ForgetRecent, (_e, raw: unknown) =>
    recents.remove(str(raw, 'path')),
  );

  ipcMain.handle(WorkspaceChannel.WriteQuery, (_e, raw: unknown) =>
    workspace.writeQuery(QueryWriteSchema.parse(raw)),
  );
  ipcMain.handle(WorkspaceChannel.DeleteQuery, (_e, raw: unknown) => {
    workspace.deleteQuery(str(raw, 'path'));
  });
  ipcMain.handle(
    WorkspaceChannel.WriteSnippets,
    (_e, snippets: unknown, baseRev: unknown, overwrite: unknown) =>
      workspace.writeSnippets(
        z.array(SnippetSchema).max(2000).parse(snippets),
        typeof baseRev === 'string' ? baseRev : null,
        overwrite === true,
      ),
  );
  ipcMain.handle(
    WorkspaceChannel.WriteNotebook,
    (_e, nb: unknown, file: unknown, baseRev: unknown, overwrite: unknown) =>
      workspace.writeNotebook(
        NotebookSchema.parse(nb),
        typeof file === 'string' ? file : null,
        typeof baseRev === 'string' ? baseRev : null,
        overwrite === true,
      ),
  );
  ipcMain.handle(WorkspaceChannel.ReadNotebook, (_e, file: unknown) =>
    workspace.readNotebook(str(file, 'file')),
  );
  ipcMain.handle(WorkspaceChannel.ProfileConfig, (_e, id: unknown) =>
    workspace.profileConfig(str(id, 'profile')),
  );
  ipcMain.handle(WorkspaceChannel.SetPassword, (_e, id: unknown, password: unknown) => {
    if (typeof password !== 'string' || password.length > 4096) throw new Error('Invalid password');
    workspace.setPassword(str(id, 'profile'), password);
  });

  ipcMain.handle(WorkspaceChannel.LaunchTake, (): LaunchAction[] => launch.takePending());

  ipcMain.handle(WorkspaceChannel.CliStatus, (): CliInstallStatus => cliStatus());
  ipcMain.handle(WorkspaceChannel.CliInstall, async (e): Promise<CliInstallStatus> => {
    if (process.platform === 'win32') return cliStatus();
    const script = scriptPath();
    const targets = installTargets(homedir());
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = {
      type: 'question' as const,
      title: 'Install command-line tool',
      message: 'Install the "plasma" command?',
      detail: [
        'It lets you run "plasma open <url | file.sqlite | folder>" and',
        '"plasma import <file> --into <url> --table <name>" from a terminal.',
        '',
        `Your user folder (${targets[0]?.dir}) needs no administrator rights.`,
        `${targets[1]?.dir} is shared by all users and may need sudo.`,
      ].join('\n'),
      buttons: ['Install for me', 'Install system-wide', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
    };
    const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    if (r.response === 2) return cliStatus();
    const target = targets[r.response] as (typeof targets)[number];
    try {
      const res = installLauncher({
        script,
        dir: target.dir,
        appImage: process.env.APPIMAGE ?? null,
        pathEnv: process.env.PATH,
      });
      return cliStatus(
        res.onPath
          ? `Installed ${res.installedAt}`
          : `Installed ${res.installedAt}. Add ${target.dir} to your PATH to use it.`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const hint = target.system
        ? ` Try: sudo ln -sf "${script}" ${join(target.dir, 'plasma')}`
        : '';
      return cliStatus(`Could not install: ${reason}.${hint}`);
    }
  });
}
