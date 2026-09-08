import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const mainEntry = join(repoRoot, 'out/main/index.js');

export type LaunchedPlasma = {
  app: ElectronApplication;
  page: Page;
  userData: string;
  dispose: () => Promise<void>;
};

/** Launch built Electron app with E2E seams. Prefer window.plasma.* IPC. */
export async function launchPlasma(
  opts: { userData?: string; env?: Record<string, string> } = {},
): Promise<LaunchedPlasma> {
  const userData = opts.userData || mkdtempSync(join(tmpdir(), 'plasma-e2e-'));
  mkdirSync(userData, { recursive: true });
  const app = await electron.launch({
    args: [mainEntry, '--password-store=basic', '--no-sandbox', '--disable-gpu'],
    env: {
      ...process.env,
      PLASMA_E2E: '1',
      PLASMA_USER_DATA: userData,
      PLASMA_DISABLE_UPDATER: '1',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      ...opts.env,
    },
    timeout: 60_000,
  });
  const page = await app.firstWindow({ timeout: 60_000 });
  await page.waitForFunction(
    () => typeof (window as unknown as { plasma?: unknown }).plasma === 'object',
    null,
    { timeout: 60_000 },
  );
  return {
    app,
    page,
    userData,
    async dispose() {
      try { await app.close(); } catch { /* ignore */ }
      try { rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

/** Invoke window.plasma.* from the renderer (real IPC). */
export async function plasmaInvoke<T>(page: Page, path: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    ([p, a]) => {
      const parts = (p as string).split('.');
      let cur: any = (window as unknown as { plasma: Record<string, unknown> }).plasma;
      for (const part of parts.slice(0, -1)) {
        cur = cur[part];
        if (cur == null) throw new Error('plasma.' + p + ': missing ' + part);
      }
      const fn = cur[parts[parts.length - 1]!];
      if (typeof fn !== 'function') throw new Error('plasma.' + p + ' is not a function');
      return fn.apply(cur, a as unknown[]);
    },
    [path, args] as const,
  );
}
