# Plasma site revamp — design spec

**Date:** 2026-05-07
**Author:** Pankaj Yadav (with Claude assist)
**Status:** Approved direction; pending implementation plan

## 1. Goal

Replace the current single-file static landing page (`site/index.html`) with
a Next.js–powered, awwwards-grade reinvention. Aesthetic: dark-luxe
"generative-tech" (sample C), with a paper/editorial light-mode counterpart
that preserves the brand's editorial DNA. Stylized SVG/Canvas mockups
everywhere — no real app screenshots required.

The site exists to convert serious developers into Plasma users on first
scroll. The bar is "I'd ship this if I had to defend it on Awwwards
Site of the Day."

## 2. Decisions log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Stack | Next.js 15 App Router, static export | Vercel-native, retains static-host parity |
| Aesthetic | Total reinvent — sample C "generative-tech" | Picked from 4 mockups |
| Output target | Replace `site/` | Old single-file deleted; new project lives in `site/` |
| Imagery | Stylized SVG/Canvas only | No screenshot pipeline, faster iteration |
| Sections | All 10 from current site, reimagined | Keep philosophy/features/cheatsheet/compare/download |
| Theme | Light + Dark toggle | Preserves current site behavior, both must feel premium |
| Tagline | "Postgres, Redis, OpenSearch — in one editorial client." | Literal, plain, lets product speak |
| Sub-tagline | "Schema-aware autocomplete · engine-aware AI · state that sticks." | Three-pillar deck |
| Body font | Inter | Tighter modern grid for sample C aesthetic |
| Display font | Newsreader | Brand DNA preserved |
| Mono | JetBrains Mono | Brand DNA preserved |

## 3. Architecture

```
site/
├─ app/
│  ├─ layout.tsx           # ReactLenis, theme-provider, fonts, metadata
│  ├─ page.tsx             # one-page composition; renders all section components
│  ├─ globals.css          # Tailwind base + tokens (dark-first), grain overlay
│  └─ favicon.ico          # mirrors public/favicon.svg
├─ components/
│  ├─ smooth-scroll.tsx    # Lenis ↔ GSAP ScrollTrigger bridge
│  ├─ theme-provider.tsx   # localStorage + prefers-color-scheme, no-FOUC inline script
│  ├─ nav.tsx              # fixed glass pill nav; magnetic CTA; theme toggle
│  ├─ hero/
│  │  ├─ index.tsx         # composition
│  │  ├─ ParticleField.tsx # canvas constellation, palette flip per theme
│  │  ├─ HeroTitle.tsx     # GSAP SplitText line reveal
│  │  └─ LiveStatsCard.tsx # glass card with count-up nums
│  ├─ pillars/Pillars.tsx
│  ├─ mock-surface/
│  │  ├─ MockSurface.tsx   # pinned, ScrollTrigger-scrubbed states
│  │  ├─ states/{Typing,Results,Explain}.tsx
│  │  └─ chrome.tsx
│  ├─ theme-cycler/ThemeCycler.tsx   # 9 swatches retint MockSurface via CSS vars
│  ├─ mockup-gallery/                # autocomplete/FK/palette horizontal scroll
│  │  ├─ Gallery.tsx
│  │  └─ vignettes/{Autocomplete,FK,Palette}.tsx
│  ├─ feature-bento/Bento.tsx
│  ├─ kbd/CheatSheet.tsx
│  ├─ compare/CompareTable.tsx
│  ├─ download/Download.tsx
│  └─ footer/Footer.tsx
├─ lib/
│  ├─ gsap.ts              # registerPlugin(ScrollTrigger, useGSAP)
│  ├─ tokens.ts            # color/font primitives mirrored from CSS vars
│  ├─ version.ts           # exports VERSION, DOWNLOAD_URL — version:sync target
│  └─ themes.ts            # the 9 theme palettes for ThemeCycler retint
├─ public/
│  ├─ og.svg               # ported from current site
│  └─ favicon.svg          # ported from current site
├─ next.config.mjs         # output: 'export', images.unoptimized: true
├─ package.json
├─ tsconfig.json
├─ tailwind.config.ts
└─ postcss.config.mjs
```

### 3.1 Static export

- `next.config.mjs`: `output: 'export'`, `images: { unoptimized: true }`,
  `trailingSlash: true`.
- Build → `out/`. Drop on any static host. Keeps `site/README.md`'s deploy
  story (Vercel/Netlify/CF Pages/S3).

### 3.2 Smooth scroll integration

- `ReactLenis root` at `app/layout.tsx`.
- `useLenis` hook bridges to `ScrollTrigger.update` and feeds Lenis's
  `raf` to `gsap.ticker`. Single bridge in `components/smooth-scroll.tsx`.
- `ScrollTrigger.normalizeScroll(true)` not used; Lenis handles wheel.

### 3.3 Animation libraries

| Library | Version | Used for |
|---------|---------|----------|
| `gsap` | ^3.14 | ScrollTrigger pinning, scrub, SplitText reveal |
| `@gsap/react` | ^2 | `useGSAP` hook with auto-cleanup |
| `motion` | ^12 | Magnetic CTAs, reveal stagger, theme transitions |
| `lenis` | ^1.1 | Smooth scroll, includes `lenis/react` |
| `animejs` | ^4 | Compare-table check-mark morph |

## 4. Theme system

### 4.1 Tokens

```css
:root {
  --paper:    #f5efe4;
  --bg:       var(--paper);
  --bg-2:     #ebe3d2;
  --fg:       #1c1a14;
  --dim:      #6b665a;
  --line:     rgba(28, 26, 20, 0.10);
  --ox:       #b54836;
  --primary:  #eb5e4e;
  --accent:   #9aa830;     /* olive-acid for light */
  --glass:    rgba(28, 26, 20, 0.04);
}
.dark {
  --bg:       #08080c;
  --bg-2:     #0d0d14;
  --fg:       #ededf2;
  --dim:      #7a7a8a;
  --line:     rgba(255, 255, 255, 0.08);
  --ox:       #eb5e4e;
  --primary:  #eb5e4e;
  --accent:   #c8ff3e;     /* electric acid for dark */
  --glass:    rgba(255, 255, 255, 0.03);
}
```

### 4.2 Theme provider

- `components/theme-provider.tsx`: thin context exposing `theme`, `setTheme`.
- No-FOUC: inline `<Script id="theme-init" strategy="beforeInteractive">`
  in `layout.tsx` reads `localStorage.theme`, falls back to
  `matchMedia('(prefers-color-scheme: dark)')`, applies `class="dark"` to
  `<html>` before paint.
- Persist on toggle.

### 4.3 Palette flips for canvas

`ParticleField.tsx` reads tokens via `getComputedStyle` and re-paints when
`html.dark` mutates (use `MutationObserver` on the html element's
`class` attribute). Avoid hardcoding hex.

## 5. Sections (motion contracts)

Each section described enough to implement; motion specifics fixed here so
the implementation plan can split into independent tasks.

### 5.1 Nav

- Fixed top, full-width, `bg-glass` + `backdrop-blur`.
- Scrolling >40px shrinks pill height 56→44 via `motion` spring.
- Items: brand mark · Stack · Features · Compare · Changelog · theme toggle · Download (magnetic, primary).
- Active section highlight via `IntersectionObserver`.

### 5.2 Hero (~110vh)

- `ParticleField` canvas, full-bleed, behind everything else.
- `[v0.0.10 · pg · redis · os]` glass chip with pulsing acid dot.
- Title: two lines, Newsreader, ~10vw.
  Line 1: "Postgres, Redis, OpenSearch —"
  Line 2: "in one *editorial* client."
  "editorial" rendered with the oxblood signature stroke.
- GSAP SplitText animates lines word-by-word, 110ms stagger, ease `power3.out`.
- Sub-tagline (Inter, --dim): "Schema-aware autocomplete · engine-aware AI · state that sticks."
- Two CTAs: `Download for Windows` (acid in dark / olive in light, magnetic), `View on GitHub` (ghost, magnetic).
- `LiveStatsCard` glass card, absolute bottom-right desktop, hidden mobile.
  Stats: latency `2.1ms` · qps `1,284` · cache hit `99.4%` · explain `index scan`.
  Numbers count up via `gsap.to` `{ snap: 1 }` on mount.
  Mini bar chart pulses (CSS animation).
- Scroll cue bottom-left: animated hairline + "scroll" mono caps.

### 5.3 Pillars (3-up)

- Pinned 100vh, ScrollTrigger scrub.
- Three columns: Schema-aware · State sticks · AI that reads.
- Big italic numeral (Newsreader, 7xl, oxblood). Underline draw on enter.
- Brief paragraph (Inter, dim).

### 5.4 Mock surface

- Pinned 200vh.
- `MockSurface` is a glass-card mock window: traffic lights · breadcrumb · sidebar tree · main pane.
- Three states pulled from `states/`. Timeline cross-fades sidebar + main as scroll progresses 0→1.
  - State A (0.0–0.33): editor showing query being typed character-by-character (GSAP `text` plugin or simulated by clipping width). Cursor blink. Sidebar dim.
  - State B (0.33–0.66): same query, results table animates in row-by-row (stagger 60ms). Total cell highlights acid.
  - State C (0.66–1.0): EXPLAIN tree expands with cost/rows annotations.
- ID `process_type` enum cell in results uses real enum values
  (`COMPANY_INFO`, `APPEND`) — referenced from app context.

### 5.5 Theme cycler

- Row of 9 themed chips (each shows 4 swatch dots + theme name in mono caps).
- Hover/click triggers a 400ms `gsap.to` on `--bg/-fg/--ox` of the
  MockSurface above. Reverts to "Plasma default" when leaving the row.
- Themes pulled from `lib/themes.ts` — port the 9 palettes from the app.

### 5.6 Mockup gallery

- 3 cards, horizontal scroll on desktop via ScrollTrigger pin + scrub.
- Mobile: vertical stack.
- Card 1 — Autocomplete: SVG editor pane with a typed `SELECT * FROM o…` and a popover suggesting `orders` (highlight) plus column hints. FK badge pulses on `customer_id`.
- Card 2 — Foreign keys: SVG of two tables joined by an animated arrow that draws on enter. Clicking would peek related rows; visualize a hover state.
- Card 3 — Palette: command palette overlay with fuzzy match highlights animating between three queries.

### 5.7 Features bento

- 7-cell asymmetric grid (`12-col`). Cells:
  1. **Hero cell** (col-span-7, row-span-2): Schema-aware AI w/ tool-use chain visualized as a small node graph (list-tables → describe → sample → write).
  2. EXPLAIN viewer (col-span-5)
  3. 9 themes (col-span-5) — animated stripe of all 9 palettes
  4. redis-cli (col-span-4)
  5. Discover search (col-span-4)
  6. State sticks (col-span-4)
- Glass cards. Hover lifts (`translate-y -2px`) + soft glow.
- Reveal-up stagger 80ms on scroll.

### 5.8 Keyboard cheat sheet

- Mono spec-sheet block, 2-column on desktop.
- Each row: `⌘ K` `Open palette`. Hairline divider between rows.
- Hover row highlights with `--glass`.
- Section header has a blinking `▍` cursor at end.

### 5.9 Compare table

- Custom grid (no semantic `<table>` for animation flexibility — `role="table"` for a11y).
- Columns: Criterion · **Plasma** · DBeaver · DataGrip · TablePlus.
- Plasma column has acid dot before name + persistent acid hairline below.
- Rows reveal one-by-one via ScrollTrigger.
- "Yes" cells start as `—` and morph to acid ✓ via Anime.js path morphing.

### 5.10 Download / CTA

- Full-bleed dark band (forced even in light mode) with `ParticleField` behind.
- "Open a quiet client." display, oxblood emphasis on "quiet".
- Three platform chips:
  - Windows (primary, magnetic) — `Download v{VERSION}`, links to `DOWNLOAD_URL`.
  - macOS · Linux — mono "soon" chip, disabled.
- Below: SHA256 (mono, 12px), `84.2 MB`, `Apache 2.0`, build hash.

### 5.11 Footer

- 12-col grid: Read · Get · About columns + brand colophon.
- Background watermark "PLASMA." in display, clipped at viewport bottom edge — only the top half of the letters visible.
- Bottom hairline + © year + license link.

## 6. Performance budget

- LCP target: <2.0s desktop, <2.5s 3G fast.
- TBT target: <100ms.
- Bundle JS budget for hero: <90 KB gzipped (lenis + gsap-core + ScrollTrigger + small motion subset).
- Images: zero raster. Everything SVG/Canvas.
- Fonts: `next/font` self-hosting, weight subset to what we use:
  Newsreader 400i/500i/600i, Inter 300/400/500/600, JetBrains Mono 400/500.
- Canvas auto-pauses (`requestAnimationFrame` cancelled) when `prefers-reduced-motion` is set.
- All ScrollTriggers killed on route unmount via `useGSAP` scope.

## 7. SEO / metadata parity

Port verbatim from current `site/index.html`:

- `<title>` and `<meta description>` (will be reworded around new tagline but same length budget).
- OG tags: `og:type`, `og:title`, `og:description`, `og:image=/og.svg`, `og:url=https://plasma.sh`.
- Twitter card tags.
- Canonical `https://plasma.sh`.
- `theme-color` light/dark via `<meta>`.
- JSON-LD `SoftwareApplication` schema, version pulled from `lib/version.ts`.

`lib/version.ts`:
```ts
export const VERSION = '0.0.10';
export const DOWNLOAD_URL = 'https://ci1uagtcki1vvf8z.public.blob.vercel-storage.com/Plasma-Setup-0.0.11-x64.exe';
```

## 8. Accessibility

- Focus ring on all interactive: 2px oxblood outline + 2px transparent
  offset.
- Theme toggle: `aria-label="Toggle theme"`, `aria-pressed` reflects state.
- `<canvas>` elements `aria-hidden="true"` (decorative).
- All section landmarks have headings; nav has `<nav aria-label="Primary">`.
- `prefers-reduced-motion: reduce` short-circuits:
  - SplitText reveal → instant fade.
  - ScrollTrigger scrub → snap to end state.
  - Canvas → static gradient mesh background only.
  - Magnetic CTAs → no movement.
- Color contrast AA: all body text ≥ 4.5:1 in both themes (verify with
  WCAG checker before ship).
- Keyboard navigable theme cycler (Arrow Left/Right between chips,
  Enter/Space activates).

## 9. Version sync

`pnpm run version:sync` script (already exists at root) currently patches
literal `0.0.10` strings in `site/index.html`. Update it to instead patch
`site/lib/version.ts`:

```ts
export const VERSION = '0.0.10';     // ← regex-patched
```

Single regex target, less fragile than the multi-occurrence patching the
old script does.

## 10. Build & deploy

Local dev:
```bash
cd site
pnpm install
pnpm dev      # localhost:3000
```

Production build:
```bash
cd site
pnpm build    # next build → out/
```

Deploy (Vercel):
```bash
vercel pull --yes
vercel build --prod
vercel deploy --prebuilt --prod
```

`site/README.md` updated to reflect Next.js workflow; deploy targets
unchanged.

## 11. Migration / removal

- Delete `site/index.html` (current single-file).
- Keep `site/README.md`, `site/og.svg` — README rewritten, og.svg moved
  to `site/public/og.svg`.
- Update `package.json` root `version:sync` script to target
  `site/lib/version.ts` instead of `site/index.html`.

## 12. Out of scope

- Newsletter signup, blog, docs site, changelog page (single page only).
- Analytics integration (no telemetry per Plasma project memory: opt-in
  telemetry only — the marketing site stays analytics-free by default).
- Internationalization.
- Real app screenshots or video recordings.
- macOS / Linux build links (chips are visible "soon" placeholders).

## 13. Risks

- **Bundle size:** GSAP + ScrollTrigger + Lenis + Motion can balloon.
  Mitigate with `next dynamic` for non-critical animation modules (compare
  table, kbd cheat sheet) and ensure tree-shaking of Motion.
- **Static export limits:** no API routes, no `next/image` optimization.
  Acceptable — site has no images and no server logic.
- **Theme cycler ↔ MockSurface coupling:** they share CSS vars in a
  scoped wrapper. If the MockSurface uses GSAP for state scrubbing, the
  cycler's CSS-var tween may fight it. Resolution: cycler tweens only
  `--mock-bg/--mock-fg/--mock-ox` namespaced vars; MockSurface's GSAP
  doesn't touch those.
- **Light-mode canvas:** ink particles on paper can look noisy at
  full opacity. Cap density and lower opacity in light mode.
