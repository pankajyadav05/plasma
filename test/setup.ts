import { vi } from 'vitest';

/**
 * Stub `electron` before any suite loads. CI sets
 * ELECTRON_SKIP_BINARY_DOWNLOAD=1; the real package throws on require
 * when its binary is missing. Main-process modules (logger → app) must
 * still be importable from unit tests that have not been split out.
 */
vi.mock('electron', async () => {
  return await import('./stubs/electron');
});
