import { SectionHead } from '@/components/plate';
import { Reveal } from '@/components/reveal';

const ITEMS = [
  ['Is it free?', 'Yes. Plasma is Apache-2.0, and the source is on GitHub.'],
  ['Which databases?', 'Postgres, Redis and OpenSearch.'],
  ['Does it need an account?', 'No.'],
  ['Is AI required?', "No. It's optional and bring-your-own-key."],
  [
    'Why does macOS warn on first launch?',
    "The builds aren't code-signed yet. See the command in the download section above.",
  ],
] as const;

export function FAQ() {
  return (
    <section id="faq" aria-labelledby="faq-title" className="py-28 md:py-44">
      <div className="wrap">
        <SectionHead plate="Appendix" name="Questions" />
        <div className="mt-16 grid gap-12 lg:grid-cols-12">
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
