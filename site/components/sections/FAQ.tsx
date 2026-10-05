import { SectionHead } from '@/components/plate';
import { Reveal } from '@/components/reveal';

const ITEMS = [
  ['Is Plasma free?', 'Yes. Plasma has the Apache-2.0 license. The source code is on GitHub.'],
  ['Which databases can I use?', 'Postgres, MySQL, MariaDB, SQLite, ClickHouse, DuckDB, Redis and OpenSearch.'],
  ['Do I need an account?', 'No.'],
  ['Is AI necessary?', 'No. AI is optional. You supply your own key.'],
  ['Why does macOS show a warning?', 'The builds do not have an Apple signature yet. Refer to the download section.'],
  ['Why does Windows show a warning?', 'The builds do not have a Microsoft signature yet. Click More info, then Run anyway.'],
] as const;

export function FAQ() {
  return (
    <section id="faq" aria-labelledby="faq-title" className="py-24 md:py-32">
      <div className="wrap">
        <SectionHead plate="Appendix" name="Questions" />
        <div className="mt-14 grid gap-12 lg:grid-cols-12">
          <Reveal className="lg:col-span-5">
            <h2 id="faq-title" className="display t-h2">
              Questions.
            </h2>
          </Reveal>
          <Reveal className="lg:col-span-7" delay={80}>
            <div className="border-t border-ink">
              {ITEMS.map(([q, a], i) => (
                <details key={q} className="group border-b border-rule">
                  <summary className="flex cursor-pointer items-center gap-5 rounded-none py-6 transition-colors duration-200 hover:bg-paper-2/60 focus-visible:outline-offset-[-2px]">
                    <span className="mono w-8 shrink-0 text-[11.5px] text-ink-2">A.{i + 1}</span>
                    <span
                      className="flex-1 text-[20px] font-bold tracking-[-0.01em] text-ink"
                      style={{ fontVariationSettings: "'wdth' 108" }}
                    >
                      {q}
                    </span>
                    <span className="faq-plus relative h-4 w-4 shrink-0" aria-hidden="true">
                      <span className="absolute left-0 top-1/2 h-px w-4 bg-ink" />
                      <span className="absolute left-1/2 top-0 h-4 w-px bg-ink transition-[transform,opacity] duration-300" />
                    </span>
                  </summary>
                  <p className="prose-p pb-7 pl-[3.25rem] pr-10">{a}</p>
                </details>
              ))}
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
