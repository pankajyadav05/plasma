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

  // Monaco token rules expect colors WITHOUT the leading `#`.
  const hex6 = (h: string) => (h.startsWith('#') ? h.slice(1, 7) : h);

  // Syntax colors stay semantically intuitive (strings green, numbers
  // blue, types amber, comments grey) for readability across palettes.
  // Keyword picks up --primary so the theme flavor still lands.
  const keywordHex = hex6(primary);
  const syntax =
    mode === 'dark'
      ? {
          string: 'A3D977',
          number: '7FB8FF',
          type: 'E8B872',
          comment: '888888',
          identifier: hex6(fg),
          delimiter: 'C0C0C0',
        }
      : {
          string: '3F6D1F',
          number: '1C4480',
          type: 'B47E11',
          comment: '888888',
          identifier: hex6(fg),
          delimiter: '555555',
        };

  return {
    base: mode === 'dark' ? 'vs-dark' : 'vs',
    inherit: false,
    rules: [
      { token: '', foreground: syntax.identifier, background: hex6(bg) },
      { token: 'keyword', foreground: keywordHex, fontStyle: 'bold' },
      { token: 'keyword.sql', foreground: keywordHex, fontStyle: 'bold' },
      { token: 'operator', foreground: syntax.delimiter },
      { token: 'operator.sql', foreground: syntax.delimiter },
      { token: 'string', foreground: syntax.string },
      { token: 'string.sql', foreground: syntax.string },
      { token: 'number', foreground: syntax.number, fontStyle: 'bold' },
      { token: 'number.sql', foreground: syntax.number, fontStyle: 'bold' },
      { token: 'comment', foreground: syntax.comment, fontStyle: 'italic' },
      { token: 'identifier', foreground: syntax.identifier },
      { token: 'type', foreground: syntax.type },
      { token: 'delimiter', foreground: syntax.delimiter },
      { token: 'predefined.sql', foreground: syntax.type },
    ],
    colors: {
      'editor.background': bg,
      'editor.foreground': fg,
      'editorGutter.background': bg,
      'editorLineNumber.foreground': mutedFg,
      'editorLineNumber.activeForeground': primary,
      'editor.selectionBackground': accent,
      'editor.inactiveSelectionBackground': `${accent}80`,
      'editor.lineHighlightBackground': `${muted}80`,
      'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': primary,
      'editorBracketMatch.background': accent,
      'editorBracketMatch.border': primary,
      'editorWidget.background': card,
      'editorWidget.foreground': cardFg,
      'editorWidget.border': border,
      'widget.shadow': mode === 'dark' ? '#00000060' : '#00000014',
      'editorSuggestWidget.background': card,
      'editorSuggestWidget.foreground': cardFg,
      'editorSuggestWidget.border': border,
      'editorSuggestWidget.selectedBackground': accent,
      'editorSuggestWidget.selectedForeground': accentFg,
      'editorSuggestWidget.selectedIconForeground': primary,
      'editorSuggestWidget.highlightForeground': primary,
      'editorSuggestWidget.focusHighlightForeground': primary,
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
