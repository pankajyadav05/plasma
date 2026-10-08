'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { GITHUB_URL, GithubIcon } from '@/components/github-icon';
import { Wordmark } from '@/components/wordmark';
import { usePlatform } from '@/lib/platform';

const links = [
  { href: '#workbench', label: 'Workbench' },
  { href: '#engines', label: 'Engines' },
  { href: '#guardrails', label: 'Guardrails' },
  { href: '#shortcuts', label: 'Shortcuts' },
  { href: '#download', label: 'Download' },
];

const NAV_LINK =
  'relative rounded-full px-3.5 py-2 text-[15px] font-medium text-ink-2 transition-colors duration-200 hover:text-ink focus-visible:text-ink after:absolute after:inset-x-3.5 after:bottom-1 after:h-px after:origin-left after:scale-x-0 after:bg-ink after:transition-transform after:duration-300 hover:after:scale-x-100 focus-visible:after:scale-x-100';

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
      {/* Wide screens: the same two columns as the page, so the logo sits over the
          index and the actions line up with the content's right edge. */}
      <div className="wrap flex h-16 items-center justify-between gap-6 xl:grid xl:max-w-none xl:grid-cols-[184px_minmax(0,1fr)] xl:gap-0 xl:px-0">
        <a href="#top" className="group flex w-fit items-baseline gap-3 rounded-sm xl:ml-7" aria-label="Plasma, back to top">
          <Wordmark className="text-[26px]" />
        </a>

        {/* The plate index replaces these links on wide screens. */}
        <nav aria-label="Primary" className="hidden md:block xl:hidden">
          <ul className="flex items-center gap-1">
            {links.map((l) => (
              <li key={l.href}>
                <a href={l.href} className={NAV_LINK}>
                  {l.label}
                </a>
              </li>
            ))}
            <li>
              <Link href="/docs/" className={NAV_LINK}>
                Docs
              </Link>
            </li>
          </ul>
        </nav>

        <div className="flex items-center gap-2 sm:gap-3 xl:mx-auto xl:w-full xl:max-w-[1400px] xl:justify-end xl:px-[clamp(20px,4vw,56px)]">
          <details className="group/menu relative md:hidden">
            <summary
              aria-label="Menu"
              className="mono grid h-10 cursor-pointer list-none place-items-center rounded-full px-3 text-[12px] font-medium uppercase tracking-[0.06em] text-ink-2 hover:bg-ink/[0.06] hover:text-ink [&::-webkit-details-marker]:hidden"
            >
              Menu
            </summary>
            <nav
              aria-label="Primary (mobile)"
              className="absolute right-0 top-12 z-50 w-48 rounded-[14px] border border-rule bg-paper p-2 shadow-[0_20px_40px_-20px_rgba(22,21,15,0.35)]"
            >
              <ul>
                {links.map((l) => (
                  <li key={l.href}>
                    <a
                      href={l.href}
                      className="block rounded-lg px-3 py-2.5 text-[15px] font-medium text-ink-2 hover:bg-ink/[0.06] hover:text-ink"
                      onClick={(e) => e.currentTarget.closest('details')?.removeAttribute('open')}
                    >
                      {l.label}
                    </a>
                  </li>
                ))}
                <li>
                  <Link
                    href="/docs/"
                    className="block rounded-lg px-3 py-2.5 text-[15px] font-medium text-ink-2 hover:bg-ink/[0.06] hover:text-ink"
                  >
                    Docs
                  </Link>
                </li>
              </ul>
            </nav>
          </details>
          <Link
            href="/docs/"
            className="mono hidden rounded-full px-3 py-2 text-[12px] font-medium uppercase tracking-[0.06em] text-ink-2 transition-colors hover:text-ink xl:inline-flex"
          >
            Docs
          </Link>
          <a
            href={GITHUB_URL}
            aria-label="Plasma on GitHub"
            className="grid h-10 w-10 place-items-center rounded-full text-ink-2 transition-colors duration-200 hover:bg-ink/[0.06] hover:text-ink"
          >
            <GithubIcon className="h-[19px] w-[19px]" />
          </a>
          <a
            href={primary?.url ?? '#download'}
            className="inline-flex h-10 items-center rounded-full bg-signal px-4 text-[15px] font-bold sm:px-5 text-signal-ink transition-[transform,background-color] duration-200 hover:bg-[#b83a22] active:scale-[0.97]"
          >
            Download
          </a>
        </div>
      </div>
    </header>
  );
}
