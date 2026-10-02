'use client';

import { useEffect, useState } from 'react';
import { GITHUB_URL, GithubIcon } from '@/components/github-icon';
import { Wordmark } from '@/components/wordmark';
import { usePlatform } from '@/lib/platform';
import { VERSION } from '@/lib/version';

const links = [
  { href: '#workbench', label: 'Workbench' },
  { href: '#engines', label: 'Engines' },
  { href: '#guardrails', label: 'Guardrails' },
  { href: '#shortcuts', label: 'Shortcuts' },
  { href: '#download', label: 'Download' },
];

export function Topbar() {
  const [scrolled, setScrolled] = useState(false);
  const { primary } = usePlatform();

  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);

  return (
    <header
      className={`sticky top-0 z-40 border-b transition-[background-color,border-color] duration-300 ${
        scrolled ? 'border-rule bg-paper/90 backdrop-blur-md' : 'border-transparent bg-paper/0'
      }`}
    >
      <div className="wrap flex h-16 items-center justify-between gap-6">
        <a href="#top" className="group flex items-baseline gap-3 rounded-sm" aria-label="Plasma, back to top">
          <Wordmark className="text-[26px]" />
          <span className="label hidden translate-y-[-2px] text-ink-2 sm:inline">v{VERSION}</span>
        </a>

        <nav aria-label="Primary" className="hidden md:block">
          <ul className="flex items-center gap-1">
            {links.map((l) => (
              <li key={l.href}>
                <a
                  href={l.href}
                  className="relative rounded-full px-3.5 py-2 text-[15px] font-medium text-ink-2 transition-colors duration-200 hover:text-ink focus-visible:text-ink after:absolute after:inset-x-3.5 after:bottom-1 after:h-px after:origin-left after:scale-x-0 after:bg-ink after:transition-transform after:duration-300 hover:after:scale-x-100 focus-visible:after:scale-x-100"
                >
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex items-center gap-2 sm:gap-3">
          <a
            href={GITHUB_URL}
            aria-label="Plasma on GitHub"
            className="grid h-10 w-10 place-items-center rounded-full text-ink-2 transition-colors duration-200 hover:bg-ink/[0.06] hover:text-ink"
          >
            <GithubIcon className="h-[19px] w-[19px]" />
          </a>
          <a
            href={primary.url}
            className="inline-flex h-10 items-center rounded-full bg-signal px-5 text-[15px] font-bold text-signal-ink transition-[transform,background-color] duration-200 hover:bg-[#b83a22] active:scale-[0.97]"
          >
            Download
          </a>
        </div>
      </div>
    </header>
  );
}
