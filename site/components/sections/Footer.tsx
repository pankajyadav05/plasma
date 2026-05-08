export function Footer() {
  return (
    <footer className="relative px-6 md:px-10 pt-16 pb-8">
      <div className="mx-auto max-w-[1440px] grid grid-cols-12 gap-6 items-end">
        <div className="col-span-12 md:col-span-6">
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-dim mb-3">colophon</div>
          <p className="text-[14px] leading-[1.6] text-dim max-w-[44ch]">
            Set in <span className="text-fg italic font-display">Fraunces</span>,{' '}
            <span className="text-fg">Geist</span>, &amp;{' '}
            <span className="text-fg font-mono">JetBrains Mono</span>. Built with Next.js,
            GSAP &amp; Lenis. Apache 2.0. Made in a quiet room in Bengaluru.
          </p>
        </div>
        <div className="col-span-6 md:col-span-3 font-mono text-[11px] uppercase tracking-[0.3em] leading-7">
          <div className="text-fg mb-2">Read</div>
          <a className="block text-dim hover:text-fg" href="#showcase">Editor</a>
          <a className="block text-dim hover:text-fg" href="#atlas">Themes</a>
          <a className="block text-dim hover:text-fg" href="#versus">Versus</a>
        </div>
        <div className="col-span-6 md:col-span-3 font-mono text-[11px] uppercase tracking-[0.3em] leading-7">
          <div className="text-fg mb-2">Get</div>
          <a className="block text-dim hover:text-fg" href="#open">Download</a>
          <a className="block text-dim hover:text-fg" href="https://github.com/pankajyadav05/plasma">GitHub</a>
          <a className="block text-dim hover:text-fg" href="https://github.com/pankajyadav05/plasma/releases">Releases</a>
        </div>
      </div>

      <div
        aria-hidden
        className="pointer-events-none select-none mt-12 leading-[0.78] text-fg/[0.08] -mb-[8vw]"
        style={{
          fontSize: 'clamp(180px, 28vw, 480px)',
          fontFamily: 'var(--font-display)',
          fontStyle: 'italic',
          fontVariationSettings: '"opsz" 144, "SOFT" 100, "WONK" 1',
          letterSpacing: '-0.05em',
        }}
      >
        Plasma<span className="text-ox/40">.</span>
      </div>

      <div className="mx-auto max-w-[1440px] mt-2 pt-4 border-t border-line flex flex-wrap justify-between gap-2 text-[11px] font-mono uppercase tracking-[0.3em] text-dim">
        <span>© 2026 Pankaj Yadav</span>
        <span>plasma.sh</span>
      </div>
    </footer>
  );
}
