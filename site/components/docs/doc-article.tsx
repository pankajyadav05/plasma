import Link from 'next/link';
import { Toc, type TocItem } from '@/components/docs/toc';
import { tocOf, neighbours } from '@/content/docs';
import type { DocPage } from '@/content/docs/types';

function Anchor({ id, title }: { id: string; title: string }) {
  return (
    <a
      href={`#${id}`}
      aria-label={`Link to ${title}`}
      className="mono ml-2 text-[0.7em] font-medium text-ink-3 no-underline opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
    >
      #
    </a>
  );
}

export function DocArticle({ page }: { page: DocPage }) {
  const toc: TocItem[] = tocOf(page);
  const { prev, next } = neighbours(page.slug);
  return (
    <div className="xl:grid xl:grid-cols-[minmax(0,720px)_220px] xl:gap-14">
      <article className="min-w-0 max-w-[720px] pb-24" aria-labelledby="doc-title">
        <p className="label text-ink-3">{page.group}</p>
        <h1 id="doc-title" className="display mt-3 text-[clamp(2.2rem,1.4rem+3vw,3.6rem)] leading-[1]">
          {page.title}
          <span className="text-signal">.</span>
        </h1>
        <p className="mt-6 text-pretty text-[19px] leading-[1.55] text-ink-2">{page.summary}</p>

        {/* On this page: inline on small screens, sticky in the right column on xl. */}
        <div className="mt-8 rounded-[12px] border border-rule bg-paper-2/70 p-5 xl:hidden">
          <Toc items={toc} />
        </div>

        {page.sections.map((s) => (
          <section key={s.id} aria-labelledby={s.id} className="mt-14 border-t border-ink pt-8">
            <h2 id={s.id} className="group display scroll-mt-24 text-[clamp(1.6rem,1.2rem+1.4vw,2.2rem)] leading-[1.05]">
              {s.title}
              <Anchor id={s.id} title={s.title} />
            </h2>
            {s.body}
            {s.subs?.map((sub) => (
              <section key={sub.id} aria-labelledby={sub.id} className="mt-9">
                <h3 id={sub.id} className="group t-h3 scroll-mt-24 !text-[1.3rem]">
                  {sub.title}
                  <Anchor id={sub.id} title={sub.title} />
                </h3>
                {sub.body}
              </section>
            ))}
          </section>
        ))}

        <nav aria-label="Previous and next page" className="mt-20 grid gap-4 border-t border-ink pt-6 sm:grid-cols-2">
          {prev ? (
            <Link
              href={`/docs/${prev.slug}/`}
              rel="prev"
              className="group rounded-[12px] border border-rule bg-paper-2/60 p-5 transition-colors hover:border-ink"
            >
              <span className="label">Previous</span>
              <span className="mt-1 block text-[18px] font-bold text-ink">{prev.title}</span>
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link
              href={`/docs/${next.slug}/`}
              rel="next"
              className="group rounded-[12px] border border-rule bg-paper-2/60 p-5 text-left transition-colors hover:border-ink sm:text-right"
            >
              <span className="label">Next</span>
              <span className="mt-1 block text-[18px] font-bold text-ink">{next.title}</span>
            </Link>
          ) : (
            <span />
          )}
        </nav>
      </article>

      <aside className="hidden xl:block" aria-label="Page contents">
        <div className="sticky top-24 max-h-[calc(100vh-8rem)] overflow-y-auto pb-8 pr-2">
          <Toc items={toc} />
        </div>
      </aside>
    </div>
  );
}
