import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const electronStub = fileURLToPath(new URL('./test/stubs/electron.ts', import.meta.url));

/**
 * Unit-test runner config. Tests live next to the code they cover as
 * `src/**\/*.test.ts` and run in a plain Node environment — the suite covers
 * pure logic (SQL compilation, protocol shapes, driver command building), not
 * Electron or the DOM. Aliases mirror `electron.vite.config.ts` so test
 * imports match production imports.
 *
 * `electron` is aliased + mocked so CI can set ELECTRON_SKIP_BINARY_DOWNLOAD=1
 * (the real package throws on require when the binary was skipped). Prefer
 * importing pure helpers (e.g. `ai-policy.ts`) from unit tests when possible.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src/renderer', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      electron: electronStub,
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    reporters: 'default',
    setupFiles: [fileURLToPath(new URL('./test/setup.ts', import.meta.url))],
  },
});
