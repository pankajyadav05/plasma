import type { Metadata } from 'next';
import Link from 'next/link';
import { PAGES, SITE_URL } from '@/content/docs';

const TITLE = 'Plasma documentation';
const DESCRIPTION =
  'How to install Plasma, connect to Postgres, MySQL, SQLite, ClickHouse, DuckDB, Redis and OpenSearch, and use every part of the desktop app.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: `${SITE_URL}/docs/` },
  openGraph: {
    type: 'website',
    title: TITLE,
    description: DESCRIPTION,
    url: `${SITE_URL}/docs/`,
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Plasma, a desktop client for SQL, Redis and OpenSearch' }],
  },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION, images: ['/og.png'] },
};

const QUICK = [
  ['Install', 'install', 'macOS, Windows and Linux, and the first-launch warnings.'],
  ['First connection', 'getting-started', 'Connect, then find your way around the workbench.'],
  ['AI assistant', 'ai-assistant', 'Providers, approval cards and exactly what is sent.'],
  ['MCP server', 'mcp-server', 'Use your databases from Claude Code, Cursor or Codex.'],
  ['Shortcuts', 'shortcuts', 'Every key, in macOS and Windows/Linux form.'],
] as const;

export default function DocsHome() {
  const groups: { group: string; pages: typeof PAGES[number][] }[] = [];
  for (const p of PAGES) {
    let g = groups.find((x) => x.group === p.group);
    if (!g) {
      g = { group: p.group, pages: [] };
      groups.push(g);
    }
    g.pages.push(p);
  }
  return (
    <div className="max-w-[980px] pb-24">
      <p className="label text-ink-3">Documentation</p>
      <h1 className="display mt-3 text-[clamp(2.4rem,1.4rem+4vw,4.4rem)] leading-[0.98]">
        Plasma docs<span className="text-signal">.</span>
      </h1>
      <p className="mt-6 max-w-[40em] text-pretty text-[19px] leading-[1.55] text-ink-2">
        Plasma is a free, open-source desktop client for Postgres, MySQL and MariaDB, SQLite, ClickHouse, DuckDB, Redis and OpenSearch.
        It stops dangerous changes before they run. These pages describe what the app does today, and what each safety feature does and does not
        cover.
      </p>

      <section aria-labelledby="quick" className="mt-14 border-t border-ink pt-6">
        <h2 id="quick" className="label text-ink">
          Start here
        </h2>
        <ul className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {QUICK.map(([name, slug, blurb]) => (
            <li key={slug}>
              <Link
                href={`/docs/${slug}/`}
                className="group flex h-full flex-col rounded-[14px] border border-rule bg-paper-2/70 p-5 transition-colors hover:border-ink"
              >
                <span className="text-[19px] font-bold text-ink">
                  {name}
                  <span aria-hidden="true" className="ml-1 text-signal transition-transform group-hover:translate-x-0.5">
                    &rarr;
                  </span>
                </span>
                <span className="mt-1.5 text-[15px] leading-snug text-ink-2">{blurb}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="all" className="mt-16 border-t border-ink pt-6">
        <h2 id="all" className="label text-ink">
          All sections
        </h2>
        <div className="mt-6 grid gap-x-10 gap-y-10 md:grid-cols-2">
          {groups.map((g) => (
            <div key={g.group}>
              <h3 className="text-[15px] font-bold uppercase tracking-[0.04em] text-ink">{g.group}</h3>
              <ul className="mt-3 divide-y divide-rule border-y border-rule">
                {g.pages.map((p) => (
                  <li key={p.slug}>
                    <Link href={`/docs/${p.slug}/`} className="block py-3 hover:bg-ink/[0.03]">
                      <span className="block text-[17px] font-semibold text-ink">{p.title}</span>
                      <span className="mt-0.5 block text-[14.5px] leading-snug text-ink-2">{p.summary}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
