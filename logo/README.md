# Plasma — Logo System

> *A literary monogram for a quiet place for queries.*

The Plasma logo is a **typographic mark** in the tradition of literary
publisher imprints (Penguin, Farrar Straus & Giroux, New Directions).
It is *not* a tech-startup abstract sigil. It is intentionally:

- **Wordmark-first** — the brand lives in the typography
- **Serif italic** — Newsreader (or Georgia as fallback)
- **Two-color** — ink (`#1C1A14`) + oxblood (`#7B2D26`) on paper cream (`#FAF7F0`)
- **Signed** — every variant has an oxblood horizontal stroke beneath the P/wordmark, like a pen underline on a signature

---

## The files

| File | Purpose | Canvas |
|---|---|---|
| `plasma-mark.svg` | Standalone monogram. The "P" alone. | 128×128 |
| `plasma-wordmark.svg` | Primary wordmark. "Plasma" in italic serif. | 520×160 |
| `plasma-lockup-h.svg` | Horizontal: mark + rule + wordmark. | 640×160 |
| `plasma-lockup-v.svg` | Vertical: mark above wordmark, both centered. | 400×360 |
| `plasma-tagline.svg` | Wordmark + "— a quiet place for queries" editorial tagline. | 720×200 |
| `plasma-mono-ink.svg` | Monochrome ink (no accent). For light backgrounds where oxblood isn't desired. | 520×160 |
| `plasma-mono-cream.svg` | Monochrome cream. For dark backgrounds (midnight theme, photography). | 520×160 |
| `plasma-mono-accent.svg` | Monochrome oxblood. For special uses (swag, bookends, singular brand beats). | 520×160 |
| `favicon.svg` | 64×64 optimized, rounded-square card, heavier weight P, larger bar proportion. Clear at 16px. | 64×64 |
| `app-icon.svg` | 1024×1024 desktop app icon with paper texture, ink frame, center P, tagline. | 1024×1024 |

---

## Color tokens

```
Paper (cream background)  #FAF7F0
Ink (primary text/mark)   #1C1A14
Oxblood (accent)          #7B2D26
Muted (tagline)           #8B8675
Rule (dividers)           #C9C2A8
```

Always use these exact values. They come directly from the Paper Editor
design tokens in `DESIGN.md`.

---

## Typography

- **Primary family**: [Newsreader](https://fonts.google.com/specimen/Newsreader) (italic, 500)
- **Fallback chain**: `Georgia → Times New Roman → serif`
- Newsreader italic is the signature face; Georgia is an elegant fallback
  that preserves the literary character on systems without Newsreader

The SVGs use `<text>` elements with `font-family="Newsreader, Georgia, …"`.
This renders beautifully in:

- Any modern browser with Newsreader available (our app bundles it)
- Any browser with Georgia (all macOS, all Windows, all iOS)
- Figma, Illustrator, Sketch, and any other vector tool

### For print / production

For print deliverables, convert text to outlines in a vector editor:

1. Open the SVG in Figma / Illustrator / Inkscape
2. Select the `<text>` element
3. **Text → Outline Text** (Illustrator) / **Object → Convert to Paths** (Inkscape) / **Outline** (Figma)
4. Export as SVG — now font-independent

---

## Usage rules

### Do

- Use `plasma-wordmark.svg` for web headers, README, social profiles, documentation
- Use `plasma-mark.svg` for tab icons, Slack emoji, single-letter placements
- Use `favicon.svg` for browser favicons and small UI affordances
- Use `app-icon.svg` for macOS `.icns` / Windows `.ico` / Linux `.desktop`
- Use `plasma-tagline.svg` for marketing pages, onboarding, splash screens
- Use mono variants in contexts where the full palette clashes (partner pages, embedded mentions, academic papers)

### Don't

- **Don't recolor** — always use the exact hex values above
- **Don't rotate** — the italic slant IS the italic serif angle, don't add more
- **Don't add strokes, glows, gradients, or shadows** — this is a flat editorial mark
- **Don't stretch / distort** the proportions — use the SVG viewBox, not CSS scaling on individual elements
- **Don't place on busy photography** — give the wordmark a paper-cream backdrop or a solid ink panel
- **Don't replace the serif font** with sans-serif — the serif IS the brand. If serifs aren't available, fall back to Georgia, not Helvetica.

---

## Exporting raster assets

For platforms that don't accept SVG (Apple's `iconset`, Windows `.ico`,
some social media uploads), rasterize from the SVG source:

```bash
# Using rsvg-convert (recommended — sharp output)
rsvg-convert -w 1024 -h 1024 logo/app-icon.svg -o app-icon-1024.png
rsvg-convert -w 512  -h 512  logo/app-icon.svg -o app-icon-512.png
rsvg-convert -w 256  -h 256  logo/app-icon.svg -o app-icon-256.png
rsvg-convert -w 128  -h 128  logo/app-icon.svg -o app-icon-128.png
rsvg-convert -w 64   -h 64   logo/app-icon.svg -o app-icon-64.png
rsvg-convert -w 32   -h 32   logo/favicon.svg -o favicon-32.png
rsvg-convert -w 16   -h 16   logo/favicon.svg -o favicon-16.png

# Or with inkscape
inkscape logo/app-icon.svg -o app-icon-1024.png -w 1024 -h 1024

# Or with a browser (npm)
npx sharp-cli -i logo/app-icon.svg -o app-icon-1024.png resize 1024 1024
```

### Required sizes by platform

| Platform | Sizes |
|---|---|
| **macOS** (`.icns`) | 16, 32, 64, 128, 256, 512, 1024 (each in @1x and @2x) |
| **Windows** (`.ico`) | 16, 20, 24, 32, 40, 48, 64, 96, 256 |
| **Linux** (`.desktop`) | 16, 22, 24, 32, 48, 64, 128, 256, 512 |
| **Favicon** | 16, 32, 48, 180 (apple-touch-icon) |
| **Social** | 400, 800, 1200 (Twitter/X, Discord, GitHub) |

---

## The design rationale

**Why a monogram and not an abstract mark?**
Plasma is a literary database client. Every other dev tool in the
category uses an abstract sigil (DBeaver's beaver, TablePlus's 3D pills,
DataGrip's teal cube). Going typographic is instantly differentiating
and matches the "a quiet place for queries" positioning.

**Why italic serif and not upright?**
The italic slant is editorial/manuscript — it evokes handwritten
marginalia and publisher's imprints. Upright serif feels like a textbook;
italic feels like a first edition.

**Why the oxblood underline?**
It's a *signature stroke*. The same visual device appears in:
- The Run button's flat offset shadow (`--shadow-offset-md`)
- The active tab indicator
- Active row left borders

Using it beneath the wordmark creates visual rhyme across the entire brand
system. It also gives the mark a point of color in an otherwise monochrome
composition — the same principle as DESIGN.md's "accent used like a laser
pointer" rule.

**Why a card frame on the app icon?**
App icons are the one context where the brand competes with a grid of
siblings. The ink-rule frame turns the icon into a *bookplate* — a
miniature object, not just a colored square. It stands out in the dock /
start menu because nothing else there looks like it.
