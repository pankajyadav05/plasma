import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Unit-test runner config. Tests live next to the code they cover as
 * `src/**\/*.test.ts` and run in a plain Node environment — the suite covers
 * pure logic (SQL compilation, protocol shapes, driver command building), not
 * Electron or the DOM. Aliases mirror `electron.vite.config.ts` so test
 * imports match production imports.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src/renderer', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    reporters: 'default',
  },
});
