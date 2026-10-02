import { join } from 'node:path';
import { app } from 'electron';
import log from 'electron-log/main.js';
import { redactLogValue } from './redact';

/**
 * Structured logger for the main process. Writes rotating files to
 * `userData/logs/main.log` with a 5MB size cap per file. Renderer
 * processes can pipe their console through here via `log.initialize()`.
 *
 * Usage from anywhere in main:
 *   import { logger } from './logger';
 *   logger.info('[plasma] foo', { bar: 1 });
 *   logger.error('[plasma] crashed', err);
 */

let initialized = false;

export function initLogger(): typeof log {
  if (initialized) return log;
  initialized = true;

  // Per-file size limit; electron-log rotates to .old automatically
  log.transports.file.maxSize = 5 * 1024 * 1024;
  log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';
  log.transports.console.format = '[{h}:{i}:{s}.{ms}] [{level}] {text}';

  // SC-27: nothing that reaches a log file may carry credentials or echoed
  // row values (error text from drivers, SQL snippets, connection strings).
  log.hooks.push((message) => {
    message.data = message.data.map(redactLogValue);
    return message;
  });

  log.transports.file.resolvePathFn = () => join(app.getPath('userData'), 'logs', 'main.log');

  // Pipe renderer console output into main.log only for development and
  // E2E runs (C34) — in shipped builds renderer logs can carry query text
  // and result values, which don't belong in a plaintext log file.
  if (!app.isPackaged || process.env.PLASMA_E2E === '1') {
    log.initialize();
  }

  log.info('[plasma] logger initialized at', log.transports.file.getFile().path);
  return log;
}

export const logger = log;
