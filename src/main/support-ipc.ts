import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { release } from 'node:os';
import { join } from 'node:path';
import {
  type SupportBundleFile,
  type SupportBundleInput,
  type SupportBundleOptions,
  type SupportBundlePreview,
  type SupportBundleSaveResult,
  SupportChannel,
  buildSupportBundle,
  totalBytes,
} from '@shared/support-bundle';
import { type BrowserWindow, app, dialog, ipcMain } from 'electron';
import { z } from 'zod';
import { workerOutput } from './line-ring';
import { logger } from './logger';
import { redactErrorText } from './redact';
import { readTail, stampForFileName, zipOf } from './support-files';

/**
 * "Create support bundle…": gathers the logs, versions, settings and saved
 * connections (the pure part lives in `@shared/support-bundle`), hands every
 * file's exact text to the renderer for review, and writes the zip only after
 * the user has seen it and chosen where it goes. Nothing is uploaded.
 */

export interface SupportIpcDeps {
  window: () => BrowserWindow | null;
  /** The connection the app is on right now. */
  active: () => { engine: string; serverVersion: string } | null;
  /** Saved connections, without passwords. */
  connections: () => unknown[];
  /** Every setting (the pure code removes secrets and everything the user wrote). */
  settings: () => Record<string, unknown>;
}

const OptionsSchema = z.object({ redactHostsAndUsers: z.boolean() });

const PREVIEW_TTL_MS = 10 * 60 * 1000;

export function gatherInput(deps: SupportIpcDeps): SupportBundleInput {
  const logs = join(app.getPath('userData'), 'logs');
  const helper = join(logs, 'update-helper.log');
  let osUser = '';
  try {
    osUser = userInfo().username;
  } catch {
    // no account name (a container without one)
  }
  return {
    generatedAt: new Date().toISOString(),
    app: {
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      osRelease: release(),
      electron: process.versions.electron ?? 'unknown',
      chrome: process.versions.chrome ?? 'unknown',
      node: process.versions.node,
      locale: app.getLocale(),
      packaged: app.isPackaged,
    },
    active: deps.active(),
    connections: deps.connections(),
    settings: deps.settings(),
    mainLog: readTail(join(logs, 'main.log')),
    mainLogOld: readTail(join(logs, 'main.old.log')),
    workerLog: redactErrorText(workerOutput.text()),
    updateHelperLog: existsSync(helper) ? readTail(helper, 256 * 1024) : null,
    osUser,
  };
}

export function registerSupportIpc(deps: SupportIpcDeps): void {
  // One preview at a time: the one on screen is the one that gets saved.
  let pending: {
    token: string;
    options: SupportBundleOptions;
    files: SupportBundleFile[];
    at: number;
  } | null = null;

  ipcMain.handle(SupportChannel.Preview, (_e, rawOptions: unknown): SupportBundlePreview => {
    const options: SupportBundleOptions = OptionsSchema.parse(rawOptions);
    const files = buildSupportBundle(gatherInput(deps), options);
    pending = { token: randomUUID(), options, files, at: Date.now() };
    return { token: pending.token, files, totalBytes: totalBytes(files) };
  });

  ipcMain.handle(
    SupportChannel.Save,
    async (_e, rawToken: unknown, rawOptions: unknown): Promise<SupportBundleSaveResult> => {
      const token = z.string().min(1).parse(rawToken);
      const options = OptionsSchema.parse(rawOptions);
      if (!pending || pending.token !== token || Date.now() - pending.at > PREVIEW_TTL_MS) {
        throw new Error('This bundle is out of date. Close the window and create it again.');
      }
      // What the checkbox says must be what the files were made with.
      if (pending.options.redactHostsAndUsers !== options.redactHostsAndUsers) {
        throw new Error(
          'The files shown are not the ones for this setting. Wait for them to refresh.',
        );
      }
      const { files } = pending;
      const win = deps.window();
      const opts = {
        title: 'Save support bundle',
        defaultPath: join(app.getPath('documents'), `plasma-support-${stampForFileName()}.zip`),
        filters: [{ name: 'Zip archive', extensions: ['zip'] }],
      };
      const picked = win
        ? await dialog.showSaveDialog(win, opts)
        : await dialog.showSaveDialog(opts);
      if (picked.canceled || !picked.filePath) return { saved: false };
      const zip = zipOf(files);
      await writeFile(picked.filePath, zip);
      logger.info('[plasma] support bundle saved', picked.filePath, `${zip.length} bytes`);
      return { saved: true, filePath: picked.filePath, bytes: zip.length };
    },
  );
}
