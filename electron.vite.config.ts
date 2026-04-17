import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
    build: {
      rollupOptions: {
        // Two entry points built into out/main/ :
        //   - index.js         (Electron main process)
        //   - workers/index.js (DB utilityProcess worker)
        // Main spawns the worker via join(__dirname, 'workers/index.js').
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'workers/index': resolve(__dirname, 'src/workers/index.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
    build: {
      // Force CommonJS + .cjs extension for the preload output.
      //
      // Electron preload scripts must be synchronously-loadable. With
      // `"type": "module"` in package.json, a `.js` output is treated as
      // ESM by Node's loader, and ESM preload loading fails silently when
      // the module graph pulls in anything complex (we hit this via
      // `zod` through `@shared/protocol`). `.cjs` bypasses all of that:
      // Node's loader unconditionally treats it as CommonJS, regardless
      // of the package.json type field.
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
          chunkFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    // Serve the top-level `logo/` folder as static assets at the root.
    // This gives us `/favicon.svg`, `/plasma-wordmark.svg`, etc. without
    // duplicating files into a separate `public/` directory.
    publicDir: resolve(__dirname, 'logo'),
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer'),
        '@shared': resolve(__dirname, 'src/shared'),
        '@logo': resolve(__dirname, 'logo'),
      },
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
        output: {
          // Split heavy vendor code into stable chunks so cached chunks survive
          // app-code updates. Monaco is the big one (~3MB) and deserves its own
          // chunk since it's lazy-loaded behind a Suspense boundary.
          manualChunks: {
            'vendor-monaco': ['@monaco-editor/react', 'monaco-editor'],
            'vendor-radix': [
              '@radix-ui/react-checkbox',
              '@radix-ui/react-dialog',
              '@radix-ui/react-label',
              '@radix-ui/react-popover',
              '@radix-ui/react-select',
              '@radix-ui/react-separator',
              '@radix-ui/react-slot',
              '@radix-ui/react-tooltip',
            ],
            'vendor-react': ['react', 'react-dom'],
          },
        },
      },
    },
    server: {
      port: 5173,
    },
  },
});
