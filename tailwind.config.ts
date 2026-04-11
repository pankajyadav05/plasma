import type { Config } from 'tailwindcss';

/**
 * Tailwind theme bound to CSS custom properties in globals.css.
 *
 * This indirection is what makes `[data-theme='midnight']` actually work:
 * every color token here resolves to `var(--name)`, and globals.css
 * changes those values based on the theme selector.
 */
export default {
  content: ['./src/renderer/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        paper: {
          DEFAULT: 'var(--bg)',
          panel: 'var(--bg-panel)',
          canvas: 'var(--bg-canvas)',
          selected: 'var(--bg-selected)',
        },
        ink: {
          DEFAULT: 'var(--fg)',
          2: 'var(--fg-2)',
          muted: 'var(--fg-muted)',
          disabled: 'var(--fg-disabled)',
        },
        rule: 'var(--rule)',
        'border-soft': 'var(--border)',
        'border-strong': 'var(--border-strong)',
        accent: {
          DEFAULT: 'var(--accent)',
          hover: 'var(--accent-hover)',
          press: 'var(--accent-press)',
        },
        type: {
          num: 'var(--type-num)',
          str: 'var(--type-str)',
          date: 'var(--type-date)',
          bool: 'var(--type-bool)',
          null: 'var(--type-null)',
          json: 'var(--type-json)',
        },
      },
      fontFamily: {
        display: ['"Newsreader"', 'Georgia', 'serif'],
        sans: ['"DM Sans"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        '2xs': ['11px', { lineHeight: '15px', letterSpacing: '0.08em' }],
        xs: ['12px', { lineHeight: '16px', letterSpacing: '0.04em' }],
        sm: ['13px', { lineHeight: '18px' }],
        base: ['14px', { lineHeight: '21px' }],
        md: ['15px', { lineHeight: '23px' }],
        lg: ['17px', { lineHeight: '25px', letterSpacing: '-0.005em' }],
        xl: ['20px', { lineHeight: '27px', letterSpacing: '-0.01em' }],
        '2xl': ['22px', { lineHeight: '28px', letterSpacing: '-0.015em' }],
        '3xl': ['38px', { lineHeight: '44px', letterSpacing: '-0.02em' }],
        '4xl': ['56px', { lineHeight: '60px', letterSpacing: '-0.025em' }],
      },
      borderRadius: {
        none: '0',
        sm: '2px',
        md: '3px',
        lg: '4px',
      },
      boxShadow: {
        none: 'none',
        // Flat offset shadows — pull colors from CSS vars so dark mode
        // gets the right accent and border-strong colors automatically.
        'offset-sm': '3px 3px 0 0 var(--border-strong)',
        'offset-md': '4px 4px 0 0 var(--accent)',
        'offset-lg': '6px 6px 0 0 var(--border-strong)',
        drop: '0 12px 32px rgba(28,26,20,0.18)',
      },
      transitionTimingFunction: {
        out: 'cubic-bezier(0.16, 1, 0.3, 1)',
        in: 'cubic-bezier(0.4, 0, 1, 1)',
      },
      transitionDuration: {
        instant: '80ms',
        fast: '140ms',
        base: '220ms',
      },
    },
  },
  plugins: [
    // biome-ignore lint/suspicious/noExplicitAny: tailwindcss-animate has no published types
    (require('tailwindcss-animate') as any),
  ],
} satisfies Config;
