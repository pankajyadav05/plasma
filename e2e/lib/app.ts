import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const mainEntry = join(repoRoot, 'out/main/index.js');
/** `electron`'s CJS entry resolves to the absolute path of its own binary. */
const electronBinary: string = createRequire(import.meta.url)('electron');

const LAUNCH_TIMEOUT_MS = 60_000;
/** Lines of app output retained for failure diagnostics. */
const OUTPUT_TAIL = 200;

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
  if (!existsSync(mainEntry)) {
    throw new Error(
      `E2E: build output missing at ${mainEntry}. Run \`pnpm run build\` first — ` +
        'in CI the plasma-out artifact from build-dev must be downloaded into out/.',
    );
  }
  if (!existsSync(electronBinary)) {
    throw new Error(
      `E2E: Electron binary missing at ${electronBinary}. Install with the binary ` +
        'download enabled (ELECTRON_SKIP_BINARY_DOWNLOAD must not be set for this job).',
    );
  }

  const userData = opts.userData || mkdtempSync(join(tmpdir(), 'plasma-e2e-'));
  mkdirSync(userData, { recursive: true });

  const launchOptions = {
    // Pin the binary instead of letting Playwright re-resolve `electron`:
    // the failure mode is otherwise a bare timeout with no path in it.
    executablePath: electronBinary,
    args: [mainEntry, '--password-store=basic', '--no-sandbox', '--disable-gpu'],
    env: {
      ...process.env,
      PLASMA_E2E: '1',
      PLASMA_USER_DATA: userData,
      PLASMA_DISABLE_UPDATER: '1',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      ...opts.env,
    },
    timeout: LAUNCH_TIMEOUT_MS,
  };

  // Playwright drains the child's stdio itself, so boot output emitted before
  // launch() resolved is gone by the time we can attach listeners. The app's
  // own rotating log (logger.ts, written under the userData redirect above)
  // keeps the ordered history, including main's boot-failure entry.
  const mainLogTail = (): string => {
    const logPath = join(userData, 'logs', 'main.log');
    if (!existsSync(logPath)) return `<no log at ${logPath}>`;
    const lines = readFileSync(logPath, 'utf8').trimEnd().split('\n');
    return lines.slice(-OUTPUT_TAIL).join('\n');
  };

  let app: ElectronApplication;
  try {
    app = await electron.launch(launchOptions);
  } catch (err) {
    throw new Error(
      `E2E: electron.launch failed for ${mainEntry}: ${err instanceof Error ? err.message : String(err)}\n` +
        'A NODE_MODULE_VERSION mismatch here means native deps were built for Node, ' +
        'not Electron — run `pnpm exec electron-builder install-app-deps`.\n' +
        `main.log tail:\n${mainLogTail()}`,
    );
  }

  // The app's own stdout/stderr is the only signal when the main process
  // never opens a window (native ABI mismatch, worker ready timeout, GPU
  // crash). Playwright's firstWindow timeout carries none of it, so keep a
  // tail and attach it to the thrown error.
  const output: string[] = [];
  const record = (tag: string) => (chunk: Buffer | string) => {
    const text = `[${tag}] ${chunk.toString().trimEnd()}`;
    output.push(text);
    if (output.length > OUTPUT_TAIL) output.shift();
    if (process.env.PLASMA_E2E_TRACE) console.log(text);
  };
  const proc = app.process();
  proc.stdout?.on('data', record('app:out'));
  proc.stderr?.on('data', record('app:err'));
  let exited = '';
  proc.on('exit', (code, signal) => {
    exited = `electron exited early (code ${code ?? 'null'}, signal ${signal ?? 'none'})`;
  });

  try {
    const page = await app.firstWindow({ timeout: LAUNCH_TIMEOUT_MS });
    await page.waitForFunction(
      () => {
        const w: unknown = window;
        if (!w || typeof w !== 'object' || !('plasma' in w)) return false;
        return typeof w.plasma === 'object' && w.plasma !== null;
      },
      null,
      { timeout: LAUNCH_TIMEOUT_MS },
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
  } catch (err) {
    try { await app.close(); } catch { /* ignore */ }
    const tail = output.length ? output.join('\n') : '<no app output captured>';
    throw new Error(
      `E2E: Plasma never reached a ready window (userData ${userData}).\n` +
        `${err instanceof Error ? err.message : String(err)}\n${exited || 'electron still running at failure'}\n` +
        `Electron output tail:\n${tail}\n` +
        `main.log tail:\n${mainLogTail()}`,
    );
  }
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
