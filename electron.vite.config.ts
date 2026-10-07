import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
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
        // Three entry points built into out/main/ :
        //   - index.js         (Electron main process)
        //   - workers/index.js (DB utilityProcess worker)
        //   - mcp-bridge.js    (stdio MCP bridge: plain Node, no Electron APIs;
        //                       `plasma mcp` runs it through the app binary)
        // Main spawns the worker via join(__dirname, 'workers/index.js').
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'mcp-bridge': resolve(__dirname, 'src/main/mcp/bridge.ts'),
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
          // Function form (not an object): an object map drags shared helpers
          // (vite's preload helper, react) into whichever listed chunk first
          // touches them, which made the 8 MB Monaco chunk a static import of
          // the entry and defeated its lazy loading.
          manualChunks(id: string) {
            // Vite's dynamic-import helper is needed by the entry; keep it out of
            // the Monaco chunk, which would otherwise have to load at startup.
            if (id.includes('vite/preload-helper')) return 'vendor-react';
            if (id.includes('/node_modules/')) {
              if (id.includes('/monaco-editor/') || id.includes('/@monaco-editor/')) {
                return 'vendor-monaco';
              }
              if (id.includes('/@radix-ui/')) return 'vendor-radix';
              if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'vendor-react';
            }
            // The shim wires the bundled Monaco (and its workers) into the loader.
            if (id.endsWith('/src/renderer/lib/monaco/monaco-react.ts')) return 'vendor-monaco';
            return undefined;
          },
        },
      },
    },
    server: {
      port: 5173,
    },
  },
});
