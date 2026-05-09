'use client';

import { useEffect, useState } from 'react';
import { DOWNLOAD_URL, SIZE_LABEL, VERSION } from '@/lib/version';

const links = [
  { href: '#specs', label: 'Specs' },
  { href: '#bench', label: 'Bench' },
  { href: '#pillars', label: 'Pillars' },
  { href: '#spectrum', label: 'Spectrum' },
  { href: '#schematic', label: 'Schematic' },
  { href: '#faq', label: 'FAQ' },
];

export function TopNav() {
  const [scrolled, setScrolled] = useState(false);
  const [time, setTime] = useState('');

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 60);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const tick = () => {
      const d = new Date();
      const hh = String(d.getUTCHours()).padStart(2, '0');
      const mm = String(d.getUTCMinutes()).padStart(2, '0');
      const ss = String(d.getUTCSeconds()).padStart(2, '0');
      setTime(`${hh}:${mm}:${ss} UTC`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-40 transition-all border-b ${
        scrolled
          ? 'bg-bg/85 backdrop-blur-md border-line-strong'
          : 'border-transparent'
      }`}
    >
      {/* Utility ribbon */}
      <div className="border-b border-line/60 px-4 md:px-8 py-1.5 flex items-center justify-between label">
        <div className="flex items-center gap-3">
          <span className="block h-1.5 w-1.5 rounded-full bg-plasma shadow-[0_0_8px_var(--plasma)]" />
          <span className="label-strong">PLASMA·LAB</span>
          <span className="hidden sm:inline">/ build {VERSION}</span>
          <span className="hidden md:inline">/ win·x64 / {SIZE_LABEL}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden md:inline">{time}</span>
          <span className="hidden lg:inline">/ apache-2.0</span>
          <span className="label-plasma">● online</span>
        </div>
      </div>

      {/* Main bar */}
      <div className="px-4 md:px-8 py-3 flex items-center justify-between">
        <a
          href="#"
          data-cursor="top"
          className="font-display text-[20px] tracking-tight inline-flex items-baseline gap-1"
          style={{ fontVariationSettings: '"opsz" 14, "wdth" 100, "wght" 800' }}
        >
          plasma<span className="text-plasma">.</span>
        </a>

        <nav className="hidden lg:flex items-center gap-7 label">
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              data-cursor="jump"
              className="hover:text-fg transition-colors"
            >
              {l.label}
            </a>
          ))}
        </nav>

        <a
          href={DOWNLOAD_URL}
          data-cursor="download"
          className="inline-flex items-center gap-2 px-4 py-2 bg-plasma text-bg font-mono text-[10px] uppercase tracking-[0.28em] hover:bg-volt transition-colors"
        >
          ↓ DOWNLOAD
        </a>
      </div>
    </header>
  );
}
