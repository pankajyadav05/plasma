import { LICENSE, SIZE_LABEL, VERSION } from '@/lib/version';

export function Footer() {
  return (
    <footer className="relative px-4 md:px-8 pt-20 pb-8 lab-grid-fine">
      <div className="mx-auto max-w-[1440px]">
        {/* Top rail */}
        <div className="grid grid-cols-12 gap-6 pb-10 border-b border-line-strong label">
          <div className="col-span-12 md:col-span-4 flex items-center gap-3">
            <span className="block h-1.5 w-1.5 rounded-full bg-plasma shadow-[0_0_8px_var(--plasma)]" />
            <span className="label-strong">PLASMA·LAB</span>
            <span>/ build {VERSION}</span>
            <span>/ {SIZE_LABEL}</span>
          </div>
          <div className="col-span-12 md:col-span-4 md:text-center">
            shipped from a quiet room · bengaluru, india
          </div>
          <div className="col-span-12 md:col-span-4 md:text-right">
            <span className="label-plasma">● </span>
            apache 2.0 · no asterisks
          </div>
        </div>

        {/* Main grid */}
        <div className="grid grid-cols-12 gap-6 py-12 items-start">
          <div className="col-span-12 md:col-span-5">
            <div className="label mb-4">colophon</div>
            <p className="text-[15px] leading-[1.7] text-fg/70 max-w-[44ch]">
              Set in{' '}
              <span className="font-display text-fg" style={{ fontVariationSettings: '"wght" 600' }}>
                Bricolage Grotesque
              </span>
              ,{' '}
              <span className="text-fg">Geist</span> &amp;{' '}
              <span className="font-mono text-fg">JetBrains Mono</span>. Built on
              Next.js with GSAP &amp; Lenis. Oscilloscope hand-rolled in 2D
              canvas. Type the word <span className="text-plasma">EXPLAIN</span>{' '}
              anywhere on the page for the hidden plan.
            </p>
          </div>

          <div className="col-span-6 md:col-span-2">
            <div className="label mb-4">read</div>
            <ul className="space-y-2 font-mono text-[12px] uppercase tracking-[0.18em]">
              <li>
                <a className="text-dim hover:text-fg" href="#specs">
                  Specs
                </a>
              </li>
              <li>
                <a className="text-dim hover:text-fg" href="#bench">
                  Bench
                </a>
              </li>
              <li>
                <a className="text-dim hover:text-fg" href="#pillars">
                  Pillars
                </a>
              </li>
              <li>
                <a className="text-dim hover:text-fg" href="#spectrum">
                  Spectrum
                </a>
              </li>
              <li>
                <a className="text-dim hover:text-fg" href="#schematic">
                  Schematic
                </a>
              </li>
              <li>
                <a className="text-dim hover:text-fg" href="#faq">
                  FAQ
                </a>
              </li>
            </ul>
          </div>

          <div className="col-span-6 md:col-span-2">
            <div className="label mb-4">get</div>
            <ul className="space-y-2 font-mono text-[12px] uppercase tracking-[0.18em]">
              <li>
                <a className="text-dim hover:text-fg" href="#open">
                  Download
                </a>
              </li>
              <li>
                <a
                  className="text-dim hover:text-fg"
                  href="https://github.com/pankajyadav05/plasma"
                >
                  GitHub
                </a>
              </li>
              <li>
                <a
                  className="text-dim hover:text-fg"
                  href="https://github.com/pankajyadav05/plasma/releases"
                >
                  Releases
                </a>
              </li>
              <li>
                <a
                  className="text-dim hover:text-fg"
                  href="https://github.com/pankajyadav05/plasma/issues"
                >
                  Issues
                </a>
              </li>
            </ul>
          </div>

          <div className="col-span-12 md:col-span-3">
            <div className="label mb-4">build manifest</div>
            <dl className="space-y-2 font-mono text-[12px]">
              {[
                ['version', `v${VERSION}`],
                ['platforms', 'mac·arm64+x64 · win·x64'],
                ['size', SIZE_LABEL],
                ['signature', 'a7d1…b88e'],
                ['license', LICENSE.toLowerCase()],
                ['language', 'typescript · rust · sql'],
              ].map(([k, v]) => (
                <div
                  key={k}
                  className="flex items-baseline justify-between gap-3 dotted-leader pb-1"
                >
                  <dt className="label">{k}</dt>
                  <dd className="text-fg/85">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>

        {/* Big watermark */}
        <div
          aria-hidden
          className="pointer-events-none select-none mt-8 leading-[0.78] text-fg/[0.06] -mb-[8vw] overflow-hidden"
          style={{
            fontSize: 'clamp(180px, 28vw, 480px)',
            fontFamily: 'var(--font-display)',
            fontVariationSettings: '"opsz" 96, "wdth" 200, "wght" 800',
            letterSpacing: '-0.06em',
          }}
        >
          plasma<span className="text-plasma/40">.</span>
        </div>

        {/* Bottom rail */}
        <div className="mt-2 pt-4 border-t border-line-strong flex flex-wrap justify-between gap-2 label">
          <span>© 2026 Pankaj Yadav</span>
          <span className="label-plasma">plasma.sh</span>
          <span>made in 2026 · still warm</span>
        </div>
      </div>
    </footer>
  );
}
