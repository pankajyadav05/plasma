import { Fragment } from 'react';

/** One keycap. */
export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="mono inline-flex min-w-[1.7em] items-center justify-center rounded-[6px] border border-rule border-b-[2px] border-b-ink-3/50 bg-paper-2 px-[6px] py-[1px] text-[0.8em] font-medium text-ink">
      {children}
    </kbd>
  );
}

const MAC: Record<string, string> = {
  mod: '⌘',
  shift: '⇧',
  alt: '⌥',
  Enter: '⏎',
  Escape: 'Esc',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Backspace: '⌫',
};
const WIN: Record<string, string> = {
  mod: 'Ctrl',
  shift: 'Shift',
  alt: 'Alt',
  Enter: 'Enter',
  Escape: 'Esc',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Backspace: 'Backspace',
};

function label(table: Record<string, string>, part: string): string {
  return table[part] ?? (part.length === 1 ? part.toUpperCase() : part);
}

/**
 * A shortcut in both forms. `k` is parts joined with "+": `mod+shift+Enter`.
 * `mod` is Cmd on macOS and Ctrl on Windows and Linux (as in the app's keymap).
 */
export function Keys({ k, mac }: { k: string; mac?: boolean }) {
  const parts = k.split('+');
  const macForm = (
    <span className="inline-flex items-center gap-[3px] whitespace-nowrap" title="macOS">
      {parts.map((p) => (
        <Kbd key={p}>{label(MAC, p)}</Kbd>
      ))}
    </span>
  );
  const winForm = (
    <span className="inline-flex items-center gap-[3px] whitespace-nowrap" title="Windows and Linux">
      {parts.map((p, i) => (
        <Fragment key={p}>
          {i > 0 && <span className="text-ink-3">+</span>}
          <Kbd>{label(WIN, p)}</Kbd>
        </Fragment>
      ))}
    </span>
  );
  if (mac === false) return winForm;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      {macForm}
      <span className="text-ink-3" aria-hidden="true">
        /
      </span>
      {winForm}
    </span>
  );
}
