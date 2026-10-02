'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Reveal } from '@/components/reveal';
import { cn } from '@/lib/cn';
import { usePlatform } from '@/lib/platform';

interface Shortcut {
  id: string;
  label: string;
  /** KeyboardEvent.code */
  code: string;
  key: string;
  shift?: boolean;
  alt?: boolean;
}

const SHORTCUTS: Shortcut[] = [
  { id: 'palette', label: 'Command palette', code: 'KeyK', key: 'K' },
  { id: 'run', label: 'Run statement', code: 'Enter', key: '↵' },
  { id: 'run-all', label: 'Run all', code: 'Enter', key: '↵', shift: true },
  { id: 'cancel', label: 'Cancel', code: 'Period', key: '.' },
  { id: 'commit', label: 'Commit changes', code: 'KeyS', key: 'S' },
  { id: 'sidebar', label: 'Toggle sidebar', code: 'KeyB', key: 'B' },
  { id: 'beautify', label: 'Beautify SQL', code: 'KeyI', key: 'I' },
  { id: 'pane', label: 'Next pane', code: 'BracketRight', key: ']', alt: true },
];

function Cap({ children, lit, down }: { children: React.ReactNode; lit?: boolean; down?: boolean }) {
  return (
    <span
      className={cn(
        'keycap',
        typeof children === 'string' && /^[↵⌘⇧⌥]$/.test(children) && 'is-glyph',
        lit && 'is-lit',
        down && !lit && 'is-down',
      )}
    >
      {children}
    </span>
  );
}

export function Shortcuts() {
  const { os } = usePlatform();
  const mac = os === 'mac';
  const [lit, setLit] = useState<string | null>(null);
  const [pressed, setPressed] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((id: string) => {
    setLit(id);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setLit(null), 900);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const mod = mac ? e.metaKey : e.ctrlKey;
      if (!mod) return;
      const hit = SHORTCUTS.find(
        (s) => s.code === e.code && !!s.shift === e.shiftKey && !!s.alt === e.altKey,
      );
      if (hit) flash(hit.id);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [mac, flash]);

  return (
    <section
      id="shortcuts"
      aria-labelledby="shortcuts-title"
      className="on-ink relative bg-ink py-28 text-paper md:py-44"
    >
      <div className="wrap">
        <div className="flex items-center gap-4 border-t border-paper/70 pt-3" aria-hidden="true">
          <span className="label text-paper">Plate 04</span>
          <span className="h-px flex-1 bg-paper/20" />
          <span className="label text-paper/70">Shortcuts</span>
        </div>

        <div className="mt-16 grid gap-8 lg:grid-cols-12">
          <Reveal className="lg:col-span-8">
            <h2 id="shortcuts-title" className="display t-h2">
              Keyboard first. Mouse optional.
            </h2>
          </Reveal>
          <Reveal className="lg:col-span-4 lg:self-end" delay={100}>
            <p className="max-w-[28em] text-[17.5px] leading-[1.55] text-paper/70">
              Try one on your own keyboard. The matching key lights up.
            </p>
          </Reveal>
        </div>

        <Reveal delay={80}>
          <ul className="mt-20 grid gap-px overflow-hidden rounded-[14px] border border-paper/15 bg-paper/15 sm:grid-cols-2 lg:grid-cols-4">
            {SHORTCUTS.map((s) => {
              const on = lit === s.id;
              return (
                <li
                  key={s.id}
                  className="group flex flex-col justify-between gap-10 bg-ink p-6 transition-colors duration-300 hover:bg-[#1d1c15] sm:p-8"
                  onPointerDown={() => setPressed(s.id)}
                  onPointerUp={() => setPressed(null)}
                  onPointerLeave={() => setPressed((p) => (p === s.id ? null : p))}
                >
                  <div className="flex flex-wrap items-center gap-2 pb-1" aria-hidden="true">
                    {(mac
                      ? [s.shift && '⇧', s.alt && '⌥', '⌘', s.key]
                      : ['Ctrl', s.shift && 'Shift', s.alt && 'Alt', s.key]
                    )
                      .filter((k): k is string => !!k)
                      .map((k) => (
                        <Cap key={k} lit={on} down={pressed === s.id}>
                          {k}
                        </Cap>
                      ))}
                  </div>
                  <p
                    className={cn(
                      'mono text-[12px] font-medium uppercase tracking-[0.06em] transition-colors duration-300',
                      on ? 'text-signal' : 'text-paper/70 group-hover:text-paper',
                    )}
                  >
                    <span className="sr-only">
                      {s.shift ? 'Shift ' : ''}
                      {s.alt ? 'Option ' : ''}
                      {mac ? 'Command' : 'Control'} {s.key === '↵' ? 'Enter' : s.key}:{' '}
                    </span>
                    {s.label}
                  </p>
                </li>
              );
            })}
          </ul>
        </Reveal>
      </div>
    </section>
  );
}
