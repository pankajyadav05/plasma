'use client';

import { useEffect, useState } from 'react';
import { VERSION } from '@/lib/version';

const links = [
  { href: '#showcase', label: 'Editor' },
  { href: '#atlas', label: 'Themes' },
  { href: '#versus', label: 'Versus' },
  { href: '#open', label: 'Open' },
];

export function TopNav() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 60);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-40 transition-colors ${
        scrolled ? 'bg-bg/85 backdrop-blur-md' : ''
      }`}
    >
      <div className="mx-auto flex max-w-[1440px] items-center justify-between px-6 md:px-10 py-5">
        <a
          href="#"
          data-cursor="home"
          className="font-display italic text-xl tracking-tight"
          style={{ fontVariationSettings: '"opsz" 12, "SOFT" 80, "WONK" 1' }}
        >
          Plasma<span className="text-ox">.</span>
        </a>

        <nav className="hidden md:flex items-center gap-10 font-mono text-[11px] uppercase tracking-[0.3em] text-dim">
          {links.map((l) => (
            <a key={l.href} href={l.href} data-cursor="jump" className="hover:text-fg">
              {l.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-5">
          <span className="hidden md:inline font-mono text-[10px] uppercase tracking-[0.3em] text-dim">
            v{VERSION}
          </span>
          <a
            href="#open"
            data-cursor="download"
            className="hidden md:inline-flex items-center gap-2 px-4 py-2 bg-ox text-bg font-mono text-[11px] uppercase tracking-[0.22em] hover:bg-accent hover:text-bg"
          >
            Download
          </a>
        </div>
      </div>
    </header>
  );
}
