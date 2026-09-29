import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

/**
 * index.html carries the production CSP (no CDN, no inline/eval script).
 * The dev server needs two relaxations: @vitejs/plugin-react injects an
 * inline React-Refresh preamble, and HMR talks over ws://localhost.
 */
function devCspPlugin(): Plugin {
  return {
    name: 'plasma-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html
        .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
        .replace("connect-src 'self'", "connect-src 'self' ws://localhost:* http://localhost:*");
    },
  };
}

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
    // The window runs with `sandbox: true`, where a preload can only
    // require('electron'). Bundle zod (pulled in via @shared/protocol)
    // instead of leaving a require('zod') that would fail at load.
    plugins: [externalizeDepsPlugin({ exclude: ['zod'] })],
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
      alias: [
        { find: '@', replacement: resolve(__dirname, 'src/renderer') },
        { find: '@shared', replacement: resolve(__dirname, 'src/shared') },
        { find: '@logo', replacement: resolve(__dirname, 'logo') },
        // C16: route every `@monaco-editor/react` import through a shim that
        // points its loader at the bundled monaco-editor (no jsDelivr).
        {
          find: /^@monaco-editor\/react$/,
          replacement: resolve(__dirname, 'src/renderer/lib/monaco/monaco-react.ts'),
        },
      ],
    },
    plugins: [react(), devCspPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
        output: {
          // Split heavy vendor code into stable chunks so cached chunks survive
          // app-code updates. Monaco is the big one (~3MB) and deserves its own
          // chunk since it's lazy-loaded behind a Suspense boundary.
          manualChunks: {
            // `@monaco-editor/react` resolves to the local-Monaco shim; name
            // the core entry it imports rather than `monaco-editor`, whose
            // main entry would drag in the TS/CSS/HTML language services.
            'vendor-monaco': ['@monaco-editor/react', 'monaco-editor/esm/vs/editor/edcore.main'],
            'vendor-radix': [
              '@radix-ui/react-checkbox',
              '@radix-ui/react-dialog',
              '@radix-ui/react-label',
              '@radix-ui/react-popover',
              '@radix-ui/react-select',
              '@radix-ui/react-separator',
              '@radix-ui/react-slot',
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
