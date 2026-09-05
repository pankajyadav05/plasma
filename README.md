# Plasma

> A quiet place for queries.

A modern Electron-based Postgres client. Ultrafast UI, keyboard-first, no Eclipse.

See [`DESIGN.md`](./DESIGN.md) for the design system (Paper Editor aesthetic).

## Stack

- **Electron** + **electron-vite** — unified Vite build for main, preload, and renderer
- **React 18** + **TypeScript** (strict) — renderer UI
- **Tailwind CSS 3** — utility styling with Paper Editor tokens
- **Zod** — typed IPC protocol (`src/shared/protocol.ts`)
- **utilityProcess** — DB drivers run in an isolated worker process per connection
- **Biome** — lint + format

## Requirements

- Node.js ≥ 20
- pnpm ≥ 9 (recommended) or npm

## Commands

```bash
pnpm install          # install dependencies
pnpm dev              # run in development with HMR (main + preload + renderer)
pnpm build            # production build (out/)
pnpm start            # preview the production build
pnpm typecheck        # tsc --noEmit for main and renderer
pnpm lint             # biome check
pnpm lint:fix         # biome check --write
```

## Releases

1. Merge your PR to `main`.
2. Run `pnpm ship:patch` (or `ship:minor` / `ship:major`) — bumps version, tags `v*`, pushes.
3. The Release GitHub Action builds Windows + macOS, uploads to Cloudflare R2, and creates a GitHub Release.

Requires repo secrets `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`. macOS builds are currently **unsigned** (`identity: null`).

## Project layout

```
plasma/
├── src/
│   ├── main/              # Electron main process
│   ├── preload/           # contextBridge surface
│   ├── workers/           # DB worker (utilityProcess)
│   ├── shared/            # IPC protocol (Zod types) — used by all processes
│   └── renderer/          # React UI
│       ├── app/
│       ├── features/      # app-shell, sidebar, editor, result-grid
│       ├── lib/           # ipc client, cn, mock-data
│       └── styles/        # global CSS + tokens
├── mockups/               # visual prototypes (index.html browses them)
├── DESIGN.md              # design system (single source of truth)
└── electron.vite.config.ts
```

## License

Apache-2.0.
