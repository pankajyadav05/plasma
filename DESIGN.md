# Plasma — Design System

> The connected workspace follows the **TablePlus workbench**: neutral
> graphite chrome, native sans UI text, monospace data, colour used only
> where it carries meaning (environment tags, the database icon, focus and
> selection). Palettes change colours only — never shape, size, radius or
> shadow.

This file replaces the original "Paper Editor" spec (cream paper, serif
italic display type, oxblood accent, offset shadows). None of that is used
any more; do not reintroduce serif / italic display headings,
letter-spaced UPPERCASE labels, coral primary buttons or offset shadows.

---

## Anti-patterns we explicitly reject

- Serif or italic display headings (`font-display italic`)
- Letter-spaced UPPERCASE labels (`uppercase tracking-wider`)
- The theme accent as a button fill — primary actions are the neutral
  "ink" button; destructive keeps the destructive tone
- Hard-coded hex colours or Tailwind palette colours (`amber-500`,
  `#d9b44a`) in components — use a token
- Remote fonts (CDNs are blocked by the CSP; everything ships locally)
- Scale transforms on hover, looping animation under reduced motion
- Emoji icons

---

## 1. Colour tokens

Defined in `src/renderer/styles/globals.css`. The default palette uses
the measured TablePlus values; named palettes (`.theme-*`) derive every
token from their palette variables with `color-mix`, so all palettes get
the same set. Components consume tokens by name, e.g.
`bg-[var(--wb-content)]`, `text-[var(--wb-text-2)]`.

| Token | Use |
|---|---|
| `--wb-window` | toolbar strip, workspace rail |
| `--wb-sidebar` | left / right sidebars, settings nav |
| `--wb-content` | editor, grid header, footers, dialogs |
| `--wb-tabbar` | tab strip |
| `--wb-control` / `-hover` / `-active` | pills, segmented tracks, icon buttons |
| `--wb-toolbar-group` / `-edge` | toolbar capsules; `-edge` is the hairline ring used on fields and popovers |
| `--wb-selected` | selected sidebar / list row |
| `--wb-segment-active` | active segment without a track |
| `--wb-field` | inputs, selects, search fields |
| `--wb-separator` | 1px lines between panes and bars |
| `--wb-text` / `-2` / `-3` | primary, secondary, tertiary text |
| `--wb-accent` | focus rings, selection outline, links — sparingly |
| `--wb-accent-fill`, `--wb-danger-fill` | accent / destructive as a fill under white text (lightness capped so white stays ≥ 4.5:1) |
| `--wb-connected` | status capsule of a connected, non-PROD session (neutral, faint accent tint) |
| `--grid-text`, `--grid-row-a/b`, `--grid-line`, `--grid-null` | result grid |
| `--status-local/dev/staging/prod/none` | environment tag chips; PROD also fills the capsule |
| `--status-warn` | amber warning text / icons |
| `--icon-folder`, `--icon-db`, `--icon-pin`, `--icon-star` | the few coloured icons |
| `--chart-1…5` | chart and map series |

**Contrast.** `--wb-text-2` clears 4.5:1 on controls and the tab strip,
`--wb-text-3` on content and sidebars, `--grid-null` ≥ 3:1 on both zebra
rows, and white text on every `--status-*` fill ≥ 4.5:1 — in the default
palette and in every named palette (light and dark). Check new tokens with
a contrast calculator before adding them.

## 2. Typography

| Role | Face |
|---|---|
| UI (chrome, dialogs, labels, headings) | `--font-sans`: system UI by default; Geist, Inter, Outfit, Plus Jakarta Sans or IBM Plex Sans via Settings → Fonts & themes |
| Data (cells, SQL, types, versions) | `--font-mono`: JetBrains Mono by default; Geist Mono, IBM Plex Mono or system mono |

All faces are bundled with `@fontsource` (`src/renderer/styles/fonts.ts`).

Scale: body 13px · secondary / helper 12px · small meta 11px · view and
dialog titles 15px semibold · empty-state titles 15px. Section headings
are 13px semibold, sentence case. Tabular numerals for data.

## 3. Sizes, radii, shadows

| Element | Size |
|---|---|
| Toolbar | 52px; capsules 34px (radius 17); status capsule 36px |
| Tab strip | 34px |
| View toolbar / footer | 38px / 36px (`ViewToolbar`, `ViewFooter`) |
| Pills, icon buttons, segmented | 24px (radius 6) |
| Fields (`Input`, `SelectTrigger`, search) | 26px (radius 7) |
| Buttons | `sm` 24px · `default` 28px · `lg` 32px |
| Tree / grid rows | 24px |
| Dialogs | radius 10, hairline ring, `shadow-xl`, overlay `black/40` |

## 4. Shared primitives

- `components/ui/button.tsx` — the single button style source. Variants:
  `primary` (neutral ink; one per dialog), `secondary`, `outline`,
  `ghost`, `destructive`, `link`; sizes `xs`, `sm`, `default`, `lg`,
  `pill`, `icon`, `icon-sm`, `icon-24`, `icon-xs`.
- `components/ui/workbench.tsx` — toolbar capsules, `Pill`, `IconButton`
  (both render through `buttonVariants`), `Segmented` (←/→ keys),
  `SplitPill`, `MenuItem` (↑/↓ keys).
- `components/ui/view-parts.tsx` — `ViewToolbar`, `ViewTitle`,
  `ViewFooter`, `SectionHeading`, `StatTile`, `EmptyState`, `Badge`.
- `components/ui/data-table.tsx` — zebra data table for every tabular body.
- `components/ui/{dialog,sheet,input,select,checkbox,label,kbd,popover}` —
  restyled to the tokens above. `DialogContent` focuses the first field on
  open (never a button) and accepts `hideClose`.

Chrome uses the workbench wrappers; forms and dialogs use `Button`.

- `features/ai/ModelPicker.tsx` — the assistant's model selector (composer chip and Settings → AI field): 560×440 popover, 44px vendor rail (monogram tiles tinted from `--chart-*`, accent bar on the active one), search, two-line rows, Legacy group, refresh footer. Only `--wb-*` / `--chart-*` / `--status-warn` / `--icon-star` tokens.
- `features/app-shell/UpdateBadge.tsx` + `UpdateToasts.tsx` — updates in the top bar: a 16px progress ring while downloading (fixed 24px box, no text jitter), an accent pill (`--wb-accent-fill` under white text) "Restart to update" when ready, an outline "Update" pill when only a manual download is possible, a muted `--status-warn` icon on error (message + "try again" in the tooltip). One-time toasts bottom-right (`--wb-content` surface, `--wb-toolbar-group-edge` hairline): "Plasma X is ready", "Updated to Plasma X", "The update could not be installed". Polite live region; every action is a button.

## 5. Motion

Motion is a seasoning. Durations: 80ms (hover / focus), 140ms (press,
dropdown), 220ms (panel). Result-grid scroll is never animated.
`prefers-reduced-motion` stops motion (see §8).

## 6. Workbench anatomy (TablePlus layout)

> Native-sans text, graphite control groups, no bottom status bar.

```text
┌ ●●● [⊟] [✕ 👁 ✓] [🔒 ⛁ SQL] ▐ PostgreSQL 16.2 : TLS : conn ▾ : db : schema ▾ / object  DEV ▌ [↻ ∿ ⌘] [⊡] ┐
├────────┬───────────────┬──────────────────────────────────────────────┬─────────────────┤
│ ⛁ db   │ [Items|Queries│ ( tab )( tab )( tab )                      + │ [Details|Asst] ⋯│
│ ◷ Hist │  |History]    ├──────────────────────────────────────────────┤ Search for field│
│ ∿ Act  │ Search…       │ SQL editor                                   │                 │
│        │ tables / saved│ line 3, column 40, location 101  [No limit▾] │ No row selected │
│        │ folders / days│            [Beautify ▾] [▶ Run Current ▾]    │  — or the row's │
│        │               │ ( Result 1 )( Result 2 )                     │  fields         │
│ ⚙ Set  │               │ # │ col │ col │ … dense striped grid          │                 │
│        │               │ [Data|Message|Chart] 8 ms  ‹ 1–50 of 586 › ⚙ ⌕ Columns Sort Export… │
└────────┴───────────────┴──────────────────────────────────────────────┴─────────────────┘
```

- **Materials** (`globals.css`, "Workbench materials"): `chrome` (toolbar, rails, sidebars, footers), `glass` (control groups, inputs, segment tracks: translucent fill, hairline stroke, lit top edge, soft drop), `raised` (active segment/tab), `hairline` borders, and grid tokens (`--grid-line`, `--grid-stripe`, `--grid-header`). Every value is `color-mix`ed from the active theme, so all palettes and light/dark share the materials.
- **Native vibrancy**: macOS windows use `vibrancy: 'under-window'` with a transparent background; `<html data-vibrancy>` makes `chrome` translucent so the desktop reads through. The editor and grid stay opaque. Other platforms get the same controls on solid chrome.
- **Primitives** (`components/ui/workbench.tsx`): `ToolbarGroup`/`ToolbarButton`, `Segmented` (`raised` or `accent`), `Pill`, `SplitPill` + `PillChevron`, `MenuItem`.
- **Status capsule** is a neutral surface faintly tinted with the accent (`--wb-connected`, text `--wb-text`); the environment tag shows as a coloured chip, and only a PROD tag fills the whole capsule red. When the capsule is too narrow it drops segments in order — transport, then server version, then schema — before truncating. It carries engine + version, transport (`TLS`/`SSH`/`No TLS`), connection switcher, database, schema switcher and the active object. There is no bottom status bar; the open-transaction controls and pending-change review (discard / preview / commit) are toolbar clusters.
- **Connection lifecycle** (`stores/reconnect.ts`): the last saved connection is remembered (`settings.lastConnectionId`) and reopened on launch (`autoConnectOnLaunch`). When a session is lost beyond main's single transparent retry (U27) or the worker crashes, the capsule shows *"Connection to X lost — retrying in Ns · Reconnect now"* and retries after 2s, 5s, 10s, 30s and 60s (`autoReconnect`), or immediately when the OS reports the network back online. After giving up, or with auto off, the whole capsule is a click-to-reconnect button. An explicit Disconnect clears `lastConnectionId`, so it is never undone. Buffered grid edits block automatic attempts; they need a human decision. The connection switcher also offers **Reconnect to X** while connected.
- **Redis & OpenSearch** use the same workbench language as Postgres: sidebar search + sliders tools menu + 24px tree rows (full-name accessible labels), `ViewToolbar` / `ViewFooter` (`components/ui/view-parts.tsx`), and `DataTable` (`components/ui/data-table.tsx`, the Postgres grid's zebra look) for every tabular body — Redis hash/list/set/zset/stream, slowlog, memory analyzer, pub/sub, OpenSearch indices, mappings, hits and SQL results. Selecting an element / document / mapping row publishes it to the right-sidebar **Details** pane (`useWorkbench.setInspectedRow`), which now exists for every engine. The session's placeholder SQL tab shows as a fixed **Overview** tab for Redis / OpenSearch. OpenSearch hides dot-prefixed system indices by default.
- **Themes are colour-only**: palettes set colour variables; radius, fonts, letter-spacing and shadow geometry come from `:root` for every palette.
- **Workspace rail**: labelled tiles (database name, History, Activity; Settings at the bottom).
- **Editor footer**: `statement N of M` (or `N selected`) and caret `line, column, location`; row-limit menu (enforced in the worker's cursor read via `maxRows`, SQL is never rewritten); Beautify split pill (Ask AI in its menu); Run split pill whose label follows the editor — **Run Selected** while text is selected, else **Run Current** — with Run Selected / Run Current / Run All / Explain Analyze in its menu.
- **Run targeting** (`lib/sql-split.ts`): the current statement is the last one starting at or before the caret, so a caret after `;` or on blank lines below a statement still means that statement. It is tinted in the editor (whole lines, accent bar) whenever the buffer has more than one statement. Each SQL tab has its own Monaco model (`path`), so cursor, scroll and undo survive tab switches, and carets are stored per tab (`useWorkbench.carets`), stamped with the buffer length so a stale caret is never trusted. Without a caret, Run Current uses the first statement; it never widens to the whole script.
- **Results footer** replaces the old toolbar, messages strip and pagination bar: `Data · Message · Chart` for SQL tabs, `Data · Structure · DDL` for tables, then timing, row range and paging, find, Columns, Sort, ⋯ (PostGIS / pgvector / mock rows), Export….
- **Grid**: 26px rows, row-number gutter (click selects), vertical grid lines, zebra stripes, sans header with mono type label.
- **Right sidebar**: `Details | Assistant` segmented header, open by default; compiled SQL / session role / RLS live in its ⋯ menu.

## 7. Settings

One surface — the Settings canvas (rail, palette, menu and ⌘, all open it;
there is no settings sheet). Sections: General, Editor, Table & grid,
Fonts & themes, Security, AI, Keymap (read-only list generated from
`@shared/keymap`), Advanced. History likewise has one surface, the
History canvas.

## 8. Accessibility floor (non-negotiable)

- Visible focus ring on every interactive element (`--ring`, 2px; must clear 3:1 on its surface)
- Tab order matches visual order, no `tabindex > 0`
- Icon-only buttons get `aria-label`
- Result grid keyboard-navigable:
  - Arrows move the selected cell
  - Enter opens the row inspector: the right-sidebar Details pane, or the drawer where no right sidebar is shown (does **not** enter edit mode)
  - F2 starts an inline edit when the grid is writable; double-click also edits
  - Esc cancels an open edit, or clears the cell selection when not editing
  - Tab / Shift+Tab move to the next / previous cell (commit first if editing)
  - Space opens the cell detail viewer for the selected cell
- Schema tree (Postgres entity list and Redis key tree) exposes ARIA `role="tree"` / `treeitem` with `aria-level`; expandable nodes also set `aria-expanded`
- Color never the only signal (NULL has glyph + color, errors have icon + color, sort has caret + color)
- `prefers-reduced-motion` stops motion: every animation plays once and ends (no looping spinners / pulses), transitions are instant
- Min hit target: 28×28px (desktop)
- Text tokens clear WCAG AA (4.5:1) on the surfaces they sit on, in every palette (see §1)
- Query completion, query errors and connection changes are announced through a polite / assertive live region (`LiveAnnouncer`)

---

---

*This document is the source of truth for visual decisions. Update it when
tokens change. Never hard-code a colour in component code that isn't a
token here.*
