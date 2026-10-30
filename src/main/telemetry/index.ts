import { app, ipcMain } from 'electron';
import { logger } from '../logger';
import { AnalyticsService } from './analytics';
import { resolveTelemetryConfig } from './config';
import { type AnalyticsEventName, type AnalyticsEvents, featureForChannel } from './events';
import { readOrCreateInstallId } from './identity';

/** How long quitting may wait for the last events. */
const SHUTDOWN_FLUSH_MS = 1_500;

let service: AnalyticsService | null = null;

/** Starts analytics when this build, this environment and the user's setting all allow it. */
export function initAnalytics(settingEnabled: boolean): void {
  const config = resolveTelemetryConfig(process.env, app.isPackaged);
  if (!config.enabled) return;
  const userData = app.getPath('userData');
  service = new AnalyticsService(
    {
      posthogKey: config.posthogKey,
      posthogHost: config.posthogHost,
      common: {
        appVersion: app.getVersion(),
        electronVersion: process.versions.electron ?? 'unknown',
        platform: process.platform,
        arch: process.arch,
      },
      installId: () => readOrCreateInstallId(userData),
      fetch: (...args) => fetch(...args),
      log: logger,
    },
    settingEnabled,
  );
  service.start();
}

export function recordAnalytics<E extends AnalyticsEventName>(
  event: E,
  properties: AnalyticsEvents[E],
): void {
  service?.record(event, properties);
}

export function setAnalyticsEnabled(enabled: boolean): void {
  service?.setEnabled(enabled);
}

export function analyticsHasPending(): boolean {
  return service?.hasPending() ?? false;
}

export function shutdownAnalytics(): Promise<void> {
  return service?.shutdown(SHUTDOWN_FLUSH_MS) ?? Promise.resolve();
}

/**
 * Wrap `ipcMain.handle` so an allowlisted channel records `feature.used` after
 * its handler succeeds. Runs before any handler is registered, like
 * `guardIpcSenders`, whose check still comes first.
 */
export function observeFeatureUse(): void {
  const original = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => {
    const feature = featureForChannel(channel);
    if (!feature) return original(channel, listener);
    return original(channel, async (event, ...args) => {
      const result = await listener(event, ...args);
      recordAnalytics('feature.used', { feature });
      return result;
    });
  };
}
