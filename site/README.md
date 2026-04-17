# Plasma — marketing site

Single-file static landing page for the Plasma app. Zero build step.

## Preview locally

Any static server works. Python one-liner:

```bash
python3 -m http.server 4000 --directory site
```

Then open <http://localhost:4000>.

## Deploy

Drop `site/index.html` onto any static host:

- **Vercel / Netlify / Cloudflare Pages** — drag-and-drop the `site/` folder
- **GitHub Pages** — push the repo, set Pages source to `/site`
- **S3 + CloudFront** — upload `index.html` as the root object

## Version sync

The version shown in download URLs / filenames is pulled from the root
`package.json`. Don't hand-edit versions in `index.html` — bump via:

```bash
pnpm run release:patch   # 0.0.2 → 0.0.3
pnpm run release:minor   # 0.0.2 → 0.1.0
pnpm run release:major   # 0.0.2 → 1.0.0
```

This bumps `package.json`, patches `site/index.html`, and stages both
files. You still write the commit and tag:

```bash
git commit -m "v0.0.3"
git tag v0.0.3
```

To re-sync the site without bumping: `pnpm run version:sync`.

(`pnpm version` / `npm version` are avoided — they shell out in a way
that fails on Windows with `spawn EINVAL` under recent Node patches.)

## Before you ship

1. **Replace download `href`s.** Search for `data-download` in `index.html`. Each link currently points to `#` and triggers an alert. Swap in real release URLs — e.g. GitHub Releases:
   ```
   https://github.com/<you>/plasma/releases/download/v0.0.2/Plasma-Setup-0.0.2-x64.exe
   ```
2. **Replace the `https://github.com/` placeholders** in the nav, download section, and footer with the real repo URL.
3. **Update Open Graph `og:image`** — add one before launching. 1200×630 with the wordmark + oxblood stroke works well.
4. **Swap Tailwind CDN for a static build** if performance matters. Right now the page ships ~40 KB HTML + the Tailwind Play runtime (~80 KB compressed). Running `npx @tailwindcss/cli -i input.css -o site/styles.css` against the page's classes removes the runtime cost.

## Brand assets

The hero, nav, and footer all use inlined SVG — the same Newsreader-italic "Plasma" wordmark and oxblood signature stroke as the app itself. Source files live in `../logo/`:

- `plasma-wordmark.svg` — full wordmark
- `plasma-mark.svg` — monogram `P`
- `plasma-mono-accent.svg` — single-color primary
- `favicon.svg` — referenced directly as the site favicon

No external dependencies beyond the Bunny Fonts webfont and Tailwind Play CDN.
