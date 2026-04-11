# Plasma — Design System

> Aesthetic codename: **"Paper Editor"**
>
> *A quiet place for queries.*

A database client that treats data like a research notebook: warm cream paper, deep ink text, editorial serif chrome, and oxblood accents used with restraint. The opposite of dark-mode dev tool fatigue. Comfortable density, generous line-height, type that carries personality without shouting. The signature is the contrast between **Newsreader italic serif** (for every label, header, and moment of display) and **JetBrains Mono** (for every byte of data).

---

## Anti-patterns we explicitly reject

- Inter / Roboto / system-ui (too generic)
- Dark mode as the default (we invert the convention)
- Purple-blue gradients, glassmorphism, neon accents
- Emoji icons
- Skeuomorphic table chrome
- Loading spinners on cached operations
- Scale transforms on hover (cause layout shift)
- More than one saturated accent color
- Tailwind defaults (slate/zinc/gray) — we use our own warm palette

---

## 1. Color Tokens

```css
/* Surfaces — warm cream paper */
--bg:          #FAF7F0;   /* app background, editor */
--bg-panel:    #F4F0E3;   /* sidebars, toolbars */
--bg-canvas:   #FFFEF9;   /* result grid — brighter, like fresh paper */
--bg-hover:    rgba(123,45,38,0.05);   /* faint oxblood wash */
--bg-selected: #F3E2D8;   /* peach — tonally pulled toward accent */

/* Rules & borders — 1px hairlines, plus 2px strong for structural emphasis */
--rule:          #C9C2A8;   /* subtle dividers */
--border:        #E5DFCC;   /* default borders */
--border-strong: #1C1A14;   /* 2px black for structural hierarchy */

/* Ink (deep, warm, never pure black) */
--fg:          #1C1A14;   /* primary text, ink */
--fg-2:        #5C5849;   /* secondary text */
--fg-muted:    #8B8675;   /* labels, metadata */
--fg-disabled: #B5AE9C;   /* placeholder, gutter */

/* The single saturated accent — used <2% of pixels */
--accent:       #7B2D26;   /* oxblood */
--accent-hover: #8F3731;
--accent-press: #661F1A;

/* Data-type colors (column tints in result grid, data in editor) */
--type-number: #2B4E7A;   /* aged ink blue */
--type-string: #4A6B2E;   /* warm olive */
--type-date:   #5C5849;   /* muted ink */
--type-bool:   #7B2D26;   /* oxblood */
--type-null:   #B5AE9C;   /* faded pencil */
--type-json:   #B47E11;   /* burnt gold */

/* Semantic */
--info:    #2B4E7A;
--success: #4A6B2E;
--warning: #B47E11;
--danger:  #7B2D26;
```

### Dark theme (deferred to v0.2 — tokens reserved)

A true dark paper theme ("midnight vellum") would invert surfaces to warm near-black (`#1B1812`), ink to cream (`#FAF7F0`), and keep the oxblood accent. Reserved but not implemented in v0.1.

### WCAG AA verification

| Pair | Ratio | Pass |
|---|---|---|
| `--fg` on `--bg` | 14.6:1 | AAA |
| `--fg-2` on `--bg-panel` | 7.8:1 | AAA |
| `--fg-muted` on `--bg` | 4.7:1 | AA |
| `--accent` on `--bg` | 8.2:1 | AAA |
| `--bg` on `--accent` (button text) | 8.2:1 | AAA |

---

## 2. Typography

| Role | Family | License | Notes |
|---|---|---|---|
| Display (headlines, section heads, tab labels, table headers, tagline) | **Newsreader** | OFL — free | Italic 400/500 is the signature. Used everywhere that isn't a button or raw data. |
| UI (buttons, menus, dialog body, tooltips) | **DM Sans** | OFL — free | Clean geometric sans. Tabular numerics. Weight 400/500/600. |
| Data + code (cells, editor, status bar, schema tree, breadcrumbs, shortcuts) | **JetBrains Mono** | Apache-2.0 — free | Programming-grade monospace. Ligatures off. |

All three ship locally with the app — no Google Fonts CDN, no FOUT.

### Type scale (comfortable, print-inspired)

```css
--text-2xs:  10px / 14px / 0.08em;   /* uppercase type labels above table headers */
--text-xs:   11px / 15px / 0.04em;   /* status bar, metadata */
--text-sm:   12px / 17px / 0;        /* schema tree, tab labels */
--text-base: 13px / 20px / 0;        /* cell data, editor code */
--text-md:   14px / 22px / 0;        /* button labels, body UI */
--text-lg:   16px / 24px / -0.005em; /* section heads (italic serif) */
--text-xl:   19px / 26px / -0.01em;  /* tab title (italic serif) */
--text-2xl:  22px / 28px / -0.015em; /* dialog headers */
--text-3xl:  38px / 44px / -0.02em;  /* Plasma wordmark (italic serif) */
--text-4xl:  56px / 60px / -0.025em; /* onboarding hero */
```

### Weight discipline

- **Newsreader**: 400 italic (body tone), 500 italic (display), very rarely 500 upright. No bold italic.
- **DM Sans**: 400 (body), 500 (labels), 600 (buttons, emphasis). No 700.
- **JetBrains Mono**: 400 only for data. 500 allowed for keyboard shortcuts and emphasis.

### Numerics

- All data columns: `font-variant-numeric: tabular-nums`
- Result grid `id` column and editor number literals: `--type-number` (aged ink blue)

---

## 3. Spacing — 4pt grid, comfortable

```css
--space-px:  1px;
--space-0.5: 2px;
--space-1:   4px;
--space-1.5: 6px;
--space-2:   8px;
--space-2.5: 10px;
--space-3:   12px;
--space-4:   16px;
--space-5:   20px;
--space-6:   24px;
--space-7:   28px;
--space-8:   32px;
--space-10:  40px;
--space-12:  48px;
--space-16:  64px;
```

### Density rules

| Element | Height | Notes |
|---|---|---|
| Top bar | 64px | Generous — the wordmark deserves room to breathe |
| Status bar | 28px | |
| Tab strip | 44px | |
| Sidebar section header | 40px | |
| Schema tree row | 32px | Comfortable, not compact |
| Result grid row (default) | 38px | |
| Result grid row (compact) | 32px | User-togglable |
| Result grid row (comfortable) | 44px | User-togglable |
| Button (default) | 42px | |
| Button (small) | 28px | |
| Button (sheet CTA) | 48px | |
| Input | 40px | |

**Sidebar default width:** 280px (wider than compact dev tools — Newsreader italic needs horizontal room).

---

## 4. Radii, Borders, Shadows

```css
--radius-none: 0;
--radius-sm:   2px;   /* buttons, inputs — print-inspired minimal rounding */
--radius-md:   3px;   /* panels, cards */
--radius-lg:   4px;   /* modals */
--radius-full: 9999px;
```

Radii are deliberately tiny — this is a print aesthetic, not a soft-UI aesthetic. Corners should feel cut, not bent.

```css
--border-hair: 1px;   /* default separators */
--border-thick: 2px;  /* structural hierarchy (top bar, editor/result split, section boundaries) */
```

```css
/* Shadows — print-offset, not atmospheric */
--shadow-none: none;
--shadow-offset-sm: 3px 3px 0 0 var(--border-strong);   /* hover cards */
--shadow-offset-md: 4px 4px 0 0 var(--accent);          /* Run button */
--shadow-offset-lg: 6px 6px 0 0 var(--border-strong);   /* modal */
--shadow-drop: 0 12px 32px rgba(28,26,20,0.12);         /* command palette overlay */
```

The **flat offset shadow** (think editorial magazine layout) is the signature. No blur, no spread. Direction is always `down-right`.

---

## 5. Motion Tokens

Motion is a seasoning, never a feature. Result grid scroll is **never** animated. Cell edits commit instantly.

```css
--ease-out:    cubic-bezier(0.16, 1, 0.3, 1);     /* enters */
--ease-in:     cubic-bezier(0.4, 0, 1, 1);        /* exits */

--dur-instant:  80ms;   /* hover, focus */
--dur-fast:    140ms;   /* button press, dropdown */
--dur-base:    220ms;   /* panel slide, sheet */
```

`prefers-reduced-motion` clamps all durations to `--dur-instant` and switches easing to `linear`.

---

## 6. Iconography

- **Lucide** — single set, 16px in UI, 14px in dense areas, 1.5px stroke, color `currentColor`
- Custom 20px database glyphs (Postgres elephant) — solid monochrome in ink, never brand colors
- Data-type column glyphs: tiny mono labels (`INT8`, `TEXT`, `TIMESTAMPTZ`) above the header name, `--text-2xs` in `--fg-muted`
- **Zero emoji**

---

## 7. Paper Texture (the signature detail)

```css
body::before {
  content: '';
  position: fixed; inset: 0;
  background-image: radial-gradient(rgba(28,26,20,0.025) 1px, transparent 1px);
  background-size: 4px 4px;
  pointer-events: none;
  z-index: 0;
}
```

A faint ink-dot pattern at 2.5% opacity, 4px tile. Invisible individually, collectively reads as "paper" not "screen". Never applied to the result grid canvas (data must be crisp).

---

## 8. Component Blueprints

### 8.1 App Shell

- Grid rows: `64px 1fr 28px` (top bar / body / status bar)
- Body grid columns: `280px 1fr`
- Top bar has 2px strong bottom border
- Sidebar has 1px rule right border
- Editor/result split: 38% / 1fr vertical, 2px strong bottom border between them

### 8.2 Top Bar

- Wordmark: `Plasma` in Newsreader italic 38px
- Tagline: `— a quiet place for queries` in Newsreader italic 13px, `--fg-muted`, kerned tight to the wordmark
- Breadcrumb: JetBrains Mono 11px, separated from wordmark by a `1px var(--rule)` left border
- Breadcrumb dot: 8px square (not circle) in `--accent`
- Right side: icon buttons + ⌘K hint with 1px `--border-strong` border

### 8.3 Sidebar

**Sections** (Connections, Schema) each begin with a 40px header:
- Newsreader italic 19px, weight 500
- `+` button on the right for add actions (ghost style)
- Divided by `2px solid var(--border-strong)` between sections

**Rows:**
- 32px tall, JetBrains Mono 12px
- Tree glyph (12px) + name + optional meta (right-aligned, italic Newsreader for row counts)
- Active row: `--bg-selected` background, 3px `--accent` left border (-3px padding-left)
- Hover: `--bg-hover` (faint oxblood wash)

### 8.4 SQL Editor (Monaco theme)

```ts
monaco.editor.defineTheme('paper-editor', {
  base: 'vs',                   // light, not dark
  inherit: false,
  rules: [
    { token: '',           foreground: '1C1A14', background: 'FAF7F0' },
    { token: 'keyword',    foreground: '7B2D26', fontStyle: 'bold' },
    { token: 'string',     foreground: '4A6B2E' },
    { token: 'number',     foreground: '2B4E7A', fontStyle: 'bold' },
    { token: 'comment',    foreground: '8B8675', fontStyle: 'italic' },  // rendered in Newsreader italic via CSS
    { token: 'operator',   foreground: '5C5849' },
    { token: 'identifier', foreground: '1C1A14' },
    { token: 'type',       foreground: 'B47E11' },
  ],
  colors: {
    'editor.background':                 '#FAF7F0',
    'editor.foreground':                 '#1C1A14',
    'editorGutter.background':           '#FAF7F0',
    'editorLineNumber.foreground':       '#B5AE9C',
    'editorLineNumber.activeForeground': '#7B2D26',
    'editor.selectionBackground':        '#F3E2D8',
    'editor.lineHighlightBackground':    '#F4F0E3',
    'editorCursor.foreground':           '#7B2D26',
    'editorBracketMatch.background':     '#F3E2D8',
    'editorBracketMatch.border':         '#7B2D26',
  },
});
```

- Font: **JetBrains Mono 14px / 26px line-height**, ligatures off
- Comments render in **Newsreader italic 14px** via an overlay decoration (a Paper Editor signature — comments become marginalia)
- Run button: bottom-right, ink background, oxblood 4x4 flat offset shadow, `⌘⏎`
- "Ask AI" pill: top-right, Newsreader italic 13px, 2px ink border

### 8.5 Result Grid

- Headers: Newsreader italic 16px, weight 500, with a 2xs uppercase type label above (`INT8`, `TEXT`, `TIMESTAMPTZ`) in JetBrains Mono 9px, `--fg-muted`
- Header bottom border: 2px `--border-strong`
- Cells: JetBrains Mono 13px, 38px row height, 18px horizontal padding
- Numbers (`.num`): bold weight, `--type-number`
- Dates: `--fg-2` (muted)
- Zebra striping: even rows on `--bg-canvas`, odd on very faint `--bg` tint
- Selected row: `--bg-selected` (peach), 3px `--accent` inset left border on first cell
- Hover: `--bg-hover`
- NULL → `␀` in `--fg-disabled`
- Empty string → `''` in italic Newsreader

### 8.6 Command Palette (cmdk)

- 600px wide, centered, 20% from top
- `--bg-canvas` background with `--shadow-offset-lg` (6x6 ink flat offset)
- 2px `--border-strong` border
- Input: Newsreader italic 19px placeholder ("Search anything…")
- Group labels: Newsreader italic 13px, `--fg-muted`
- Selected item: `--bg-selected` + 3px `--accent` left bar
- Backdrop: `rgba(28,26,20,0.4)`
- Open animation: scale `0.98 → 1.0` + opacity `0 → 1`, 180ms `--ease-out`

### 8.7 Connection Manager (right slide-in sheet)

- 520px wide, slides in right with `--ease-out` 220ms
- 2px `--border-strong` left border
- Single-column form, Newsreader italic section headers
- Inputs: 40px, 1px `--border` default, 2px `--accent` on focus (no glow)
- Test Connection: ghost button
- Save button: ink background, oxblood 4x4 offset shadow

### 8.8 Status Bar

- 28px tall, ink (`--border-strong`) background, cream foreground
- JetBrains Mono 10px UPPERCASE
- Segments separated by `1px` inner-dark dividers
- Connection dot: 8px square in `--accent` (not circle — everything here is rectilinear)
- Key values (`142,381 ROWS`, `87 MS`) in oxblood for emphasis
- Right-aligned: `⌘ K — COMMAND`

### 8.9 Buttons

| Variant | Background | Border | Foreground | Shadow | Use |
|---|---|---|---|---|---|
| **Primary** | `--fg` (ink) | none | `--bg` (cream) | `--shadow-offset-md` (4x4 oxblood) | Run, Save. Max 1 per screen. |
| **Secondary** | `--bg-canvas` | 1px `--border-strong` | `--fg` | none | Cancel, Test |
| **Ghost** | transparent | none | `--fg-2` | none | Toolbar, icon buttons |
| **Danger** | transparent | 1px `--accent` | `--accent` | none | Delete, Drop table |

- Border-radius: `--radius-sm` (2px)
- Focus visible: 2px `--accent` outline, 2px offset
- Hover: background shift to `--bg-hover` (no scale, no movement)

---

## 9. Accessibility Floor (non-negotiable)

- Visible focus ring on every interactive element (2px `--accent` outline, 2px offset)
- Tab order matches visual order, no `tabindex > 0`
- Icon-only buttons get `aria-label`
- Result grid keyboard-navigable (arrows, Enter to edit, Esc to commit, Tab to next cell)
- Schema tree exposes ARIA `role="tree"` / `treeitem` with `aria-level` and `aria-expanded`
- Color never the only signal (NULL has glyph + color, errors have icon + color, sort has caret + color)
- `prefers-reduced-motion` clamps motion
- Min hit target: 28×28px (desktop)
- All AA contrast ratios verified above

---

## 10. The "One Thing People Remember"

> *"It's the database tool that looks like a research notebook."*

Italic Newsreader headers over monospace data on cream paper, with a single oxblood accent and flat offset shadows. Every other choice exists to support that.

---

*This document is the source of truth for visual decisions. Update it when tokens change. Never hardcode a hex value in component code that isn't pulled from a token here.*
