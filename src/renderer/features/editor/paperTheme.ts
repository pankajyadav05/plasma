import type * as MonacoType from 'monaco-editor';

/**
 * Monaco theme — derived from the currently-active CSS custom properties
 * so palette switches (supabase, violet-bloom, …) propagate into the
 * editor. Monaco only accepts hex strings, so we resolve each `--var`
 * through the DOM + Canvas 2D (which normalizes oklch/rgb to hex).
 *
 * Re-register + setTheme whenever the app theme changes — call
 * `applyMonacoTheme(monaco, mode)` from the editor mount and again on
 * `plasma:theme-changed` window events.
 */

export const PLASMA_THEME_ID = 'plasma-current';
// Legacy ids kept for any stray `setTheme` callers; both alias the live theme.
export const LIGHT_THEME_ID = PLASMA_THEME_ID;
export const DARK_THEME_ID = PLASMA_THEME_ID;

/**
 * Resolves `var(--name)` to `#RRGGBB` by letting the browser compute the
 * color on a hidden probe, then running it through a canvas 2D context
 * which normalizes any CSS color (oklch, hsl, rgb, named) to hex.
 * Returns the fallback on any failure so Monaco never gets a bad value.
 */
function resolveCssColor(varName: string, fallback: string): string {
  try {
    const probe = document.createElement('span');
    probe.style.color = `var(${varName})`;
    probe.style.display = 'none';
    document.body.appendChild(probe);
    const resolved = getComputedStyle(probe).color;
    document.body.removeChild(probe);
    if (!resolved) return fallback;

    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return fallback;
    ctx.fillStyle = '#000';
    ctx.fillStyle = resolved;
    const out = ctx.fillStyle;
    if (typeof out !== 'string') return fallback;
    if (/^#[0-9a-f]{6}$/i.test(out)) return out;
    const m = out.match(
      /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i,
    );
    if (!m) return fallback;
    const toHex = (n: number) => Math.round(n).toString(16).padStart(2, '0');
    return `#${toHex(+m[1])}${toHex(+m[2])}${toHex(+m[3])}`;
  } catch {
    return fallback;
  }
}

/** True when no named palette (`theme-*` class on <html>) is active. */
function isDefaultPalette(): boolean {
  for (const cls of document.documentElement.classList) {
    if (cls.startsWith('theme-')) return false;
  }
  return true;
}

function buildTheme(mode: 'light' | 'dark'): MonacoType.editor.IStandaloneThemeData {
  const bg = resolveCssColor('--background', mode === 'dark' ? '#252525' : '#FFFFFF');
  const fg = resolveCssColor('--foreground', mode === 'dark' ? '#FBFBFB' : '#252525');
  const primary = resolveCssColor('--primary', '#EB5E4E');
  const border = resolveCssColor('--border', mode === 'dark' ? '#3A3A3A' : '#EBEBEB');
  const muted = resolveCssColor('--muted', mode === 'dark' ? '#333333' : '#F7F7F7');
  const mutedFg = resolveCssColor('--muted-foreground', mode === 'dark' ? '#888888' : '#A0A0A0');
  const accent = resolveCssColor('--accent', mode === 'dark' ? '#3A3A3A' : '#F4F4F4');
  const accentFg = resolveCssColor('--accent-foreground', fg);
  const card = resolveCssColor('--card', bg);
  const cardFg = resolveCssColor('--card-foreground', fg);
  // The app accent (grid selection outline, focus rings, links). The
  // editor's selection / bracket / suggest highlights follow it so the
  // editor and grid never disagree on the accent colour (V8).
  const wbAccent = resolveCssColor('--wb-accent', primary);

  // Monaco token rules expect colors WITHOUT the leading `#`.
  const hex6 = (h: string) => (h.startsWith('#') ? h.slice(1, 7) : h);

  // Default theme = TablePlus syntax palette (SPEC §2): muted blue
  // keywords (not bold), rose strings, violet numbers, grey italic
  // comments. Named palettes keep deriving from their own variables so
  // the theme flavour still lands (keyword = --primary).
  const isDefault = isDefaultPalette();
  const syntax = isDefault
    ? mode === 'dark'
      ? {
          keyword: '659AD4',
          keywordStyle: '',
          string: 'BF7471',
          number: 'AC7CF8',
          numberStyle: '',
          type: '6399D4',
          comment: '7F7F7F',
          identifier: 'C1C0C1',
          delimiter: 'C1C0C1',
        }
      : {
          keyword: '0B57D0',
          keywordStyle: '',
          string: 'C41A16',
          number: '7C3AED',
          numberStyle: '',
          type: '0B57D0',
          comment: '8E8E93',
          identifier: '1D1D1F',
          delimiter: '1D1D1F',
        }
    : mode === 'dark'
      ? {
          keyword: hex6(primary),
          keywordStyle: 'bold',
          string: 'A3D977',
          number: '7FB8FF',
          numberStyle: 'bold',
          type: 'E8B872',
          comment: '888888',
          identifier: hex6(fg),
          delimiter: 'C0C0C0',
        }
      : {
          keyword: hex6(primary),
          keywordStyle: 'bold',
          string: '3F6D1F',
          number: '1C4480',
          numberStyle: 'bold',
          type: 'B47E11',
          comment: '888888',
          identifier: hex6(fg),
          delimiter: '555555',
        };

  // Editor chrome colours. Default theme: TablePlus graphite (bg #242424,
  // grey line numbers, white active number, near-invisible current line)
  // with selection / bracket match tinted by the app accent. Named
  // themes: derived from their palette.
  const ed = isDefault
    ? mode === 'dark'
      ? {
          bg: '#242424',
          fg: '#C1C0C1',
          lineNumber: '#7F7F7F',
          lineNumberActive: '#FFFFFF',
          lineHighlight: '#2A2A2A',
          selection: `${wbAccent}4D`,
          cursor: '#E0E0E0',
          accent: wbAccent,
        }
      : {
          bg: '#FFFFFF',
          fg: '#1D1D1F',
          lineNumber: '#8E8E93',
          lineNumberActive: '#1D1D1F',
          lineHighlight: '#F7F7F7',
          selection: `${wbAccent}33`,
          cursor: '#1D1D1F',
          accent: wbAccent,
        }
    : {
        bg,
        fg,
        lineNumber: mutedFg,
        lineNumberActive: primary,
        lineHighlight: `${muted}80`,
        selection: accent,
        cursor: wbAccent,
        accent: wbAccent,
      };

  return {
    base: mode === 'dark' ? 'vs-dark' : 'vs',
    inherit: false,
    rules: [
      { token: '', foreground: syntax.identifier, background: hex6(ed.bg) },
      { token: 'keyword', foreground: syntax.keyword, fontStyle: syntax.keywordStyle },
      { token: 'keyword.sql', foreground: syntax.keyword, fontStyle: syntax.keywordStyle },
      { token: 'operator', foreground: syntax.delimiter },
      { token: 'operator.sql', foreground: syntax.delimiter },
      { token: 'string', foreground: syntax.string },
      { token: 'string.sql', foreground: syntax.string },
      { token: 'number', foreground: syntax.number, fontStyle: syntax.numberStyle },
      { token: 'number.sql', foreground: syntax.number, fontStyle: syntax.numberStyle },
      { token: 'comment', foreground: syntax.comment, fontStyle: 'italic' },
      { token: 'identifier', foreground: syntax.identifier },
      { token: 'type', foreground: syntax.type },
      { token: 'delimiter', foreground: syntax.delimiter },
      { token: 'predefined.sql', foreground: syntax.type },
    ],
    colors: {
      'editor.background': ed.bg,
      'editor.foreground': ed.fg,
      'editorGutter.background': ed.bg,
      'editorLineNumber.foreground': ed.lineNumber,
      'editorLineNumber.activeForeground': ed.lineNumberActive,
      'editor.selectionBackground': ed.selection,
      'editor.inactiveSelectionBackground': isDefault
        ? `${ed.selection.slice(0, 7)}26`
        : `${accent}80`,
      'editor.lineHighlightBackground': ed.lineHighlight,
      'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': ed.cursor,
      'editorBracketMatch.background': isDefault ? '#00000000' : accent,
      'editorBracketMatch.border': isDefault ? `${ed.accent}99` : primary,
      'editorWidget.background': card,
      'editorWidget.foreground': cardFg,
      'editorWidget.border': border,
      'widget.shadow': mode === 'dark' ? '#00000060' : '#00000014',
      'editorSuggestWidget.background': card,
      'editorSuggestWidget.foreground': cardFg,
      'editorSuggestWidget.border': border,
      'editorSuggestWidget.selectedBackground': accent,
      'editorSuggestWidget.selectedForeground': accentFg,
      'editorSuggestWidget.selectedIconForeground': ed.accent,
      'editorSuggestWidget.highlightForeground': ed.accent,
      'editorSuggestWidget.focusHighlightForeground': ed.accent,
      'list.focusBackground': accent,
      'list.focusForeground': accentFg,
      'list.hoverBackground': muted,
      'list.hoverForeground': fg,
      'list.activeSelectionBackground': accent,
      'list.activeSelectionForeground': accentFg,
      'editorIndentGuide.background1': border,
      'editorIndentGuide.activeBackground1': mutedFg,
      'scrollbarSlider.background': mode === 'dark' ? '#FFFFFF22' : '#00000022',
      'scrollbarSlider.hoverBackground': mode === 'dark' ? '#FFFFFF55' : '#00000055',
      'scrollbarSlider.activeBackground': mode === 'dark' ? '#FFFFFF88' : '#00000088',
    },
  };
}

/**
 * Registers and activates the live theme. Call once at mount, and again
 * whenever `plasma:theme-changed` fires.
 */
export function applyMonacoTheme(monaco: typeof MonacoType, mode: 'light' | 'dark'): void {
  monaco.editor.defineTheme(PLASMA_THEME_ID, buildTheme(mode));
  monaco.editor.setTheme(PLASMA_THEME_ID);
}

/** Legacy entry point — same as `applyMonacoTheme(monaco, 'light')` idempotent. */
export function registerMonacoThemes(monaco: typeof MonacoType): void {
  const mode = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
  applyMonacoTheme(monaco, mode);
}
