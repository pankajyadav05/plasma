import { app } from 'electron';
import type { WorkerSupervisor } from './worker-supervisor';
import { logger } from './logger';

/**
 * E2E-only hooks. Registered exclusively when `PLASMA_E2E=1`. Exposed on
 * `globalThis.__plasmaE2E` so Playwright can reach them via
 * `electronApp.evaluate(({ app }) => …)` / main-world globals.
 *
 * Never loaded on production paths when the env var is unset.
 */
export type PlasmaE2EHooks = {
  killWorker(): void;
  workerPid(): number | null;
  userDataPath(): string;
};

declare global {
  var __plasmaE2E: PlasmaE2EHooks | undefined;
}

export function registerE2EHooks(getSupervisor: () => WorkerSupervisor): void {
  if (process.env.PLASMA_E2E !== '1') return;

  const hooks: PlasmaE2EHooks = {
    killWorker() {
      getSupervisor().killWorkerForE2E();
    },
    workerPid() {
      return getSupervisor().workerPid();
    },
    userDataPath() {
      return app.getPath('userData');
    },
  };

  globalThis.__plasmaE2E = hooks;
  logger.info('[plasma] E2E hooks registered');
}
