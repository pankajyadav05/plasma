import { GITHUB_URL } from '@/components/github-icon';
import { Wordmark } from '@/components/wordmark';
import { LICENSE } from '@/lib/feed';

export function Footer() {
  return (
    <footer className="on-ink bg-ink text-paper">
      <div className="wrap pb-10 pt-24 md:pt-32">
        <div className="flex flex-col gap-14 md:flex-row md:items-end md:justify-between">
          <Wordmark className="text-[clamp(4rem,2rem+10vw,10rem)] !leading-[0.85] text-paper" />
          <ul className="mono flex flex-wrap gap-x-8 gap-y-3 text-[12px] font-medium uppercase tracking-[0.06em]">
            {[
              ['#workbench', 'Workbench'],
              ['#engines', 'Engines'],
              ['#guardrails', 'Guardrails'],
              ['#download', 'Download'],
            ].map(([h, l]) => (
              <li key={h}>
                <a href={h} className="text-paper/70 transition-colors hover:text-paper">
                  {l}
                </a>
              </li>
            ))}
            <li>
              <a href={GITHUB_URL} className="text-paper/70 transition-colors hover:text-paper">
                GitHub ↗
              </a>
            </li>
          </ul>
        </div>

        <div className="mono mt-20 flex flex-col gap-3 border-t border-paper/20 pt-6 text-[11.5px] tracking-[0.02em] text-paper/65 md:flex-row md:justify-between">
          <p>{LICENSE}</p>
          <p>The screenshots show the real app with sample data.</p>
        </div>
      </div>
    </footer>
  );
}
