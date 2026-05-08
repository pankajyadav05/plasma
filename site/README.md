# Plasma — marketing site

Next.js 15 (App Router) marketing site for the Plasma desktop app.
Static export → drop on any static host.

## Stack

- Next.js 15, React 19, TypeScript
- Tailwind 4 (CSS-first `@theme` config)
- GSAP 3 + ScrollTrigger + `@gsap/react`
- Lenis 1 (smooth scroll, bridged into ScrollTrigger)
- Motion 12 (limited use)
- Anime.js 4 (path morphs)
- Fonts via `next/font/google`: Newsreader, Inter, JetBrains Mono

## Develop

```bash
cd site
pnpm install
pnpm dev          # localhost:3000
```

This is a nested project — its own `node_modules`. The root pnpm install
(for the Electron app) does not touch it.

## Build

```bash
pnpm build        # next build → out/
```

`out/` is a fully static bundle. Drop on any static host.

## Deploy (Vercel)

Vercel auto-builds from `main`. Project root must be set to `site/` in
the Vercel dashboard.

Manual deploy if needed:

```bash
vercel pull --yes
vercel build --prod
vercel deploy --prebuilt --prod
```

## Version sync

The version literal lives in `lib/version.ts`. The repo-root release
flow patches it automatically — don't hand-edit:

```bash
pnpm run release:patch   # at repo root: 0.0.10 → 0.0.11
pnpm run release:minor
pnpm run release:major
```

To re-sync without bumping: `pnpm run version:sync` at repo root.

## Brand assets

Source SVGs live in `../logo/`. The favicon and OG image are copied
into `public/` here; replace if branding shifts.

## Architecture

```
site/
├─ app/             # layout, page, globals.css
├─ components/      # one folder per major section
├─ lib/             # gsap, version, themes, cn
└─ public/          # static assets (og.svg, favicon.svg)
```

Each section is a self-contained `'use client'` component composed in
`app/page.tsx`. Shared smooth-scroll and theme provider live at the
layout root.
