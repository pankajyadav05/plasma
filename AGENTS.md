# Repo guide for agents

Plasma — Electron + React + TypeScript Postgres client.

- Install: `pnpm install`
- Test: `pnpm test` (vitest; unit tests live beside code as `src/**/*.test.ts`)
- Typecheck: `pnpm typecheck`
- Lint/format: `pnpm lint` / `pnpm lint:fix` (Biome, not ESLint/Prettier)

## Style

- TypeScript strict; typed IPC protocol lives in `src/shared/protocol.ts` (Zod).
- DB drivers run in isolated `utilityProcess` workers (`src/workers/`).
- Tailwind CSS 4 with the Paper Editor tokens — see `DESIGN.md`.

## Never touch

- `.github/`
- `resources/`, `logo/` (generated icons; use `pnpm build:icons`)
- Do not commit or push — the orchestrator handles git.
