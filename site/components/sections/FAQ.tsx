import Link from 'next/link';
import { SectionHead } from '@/components/plate';
import { Reveal } from '@/components/reveal';
import { Sheet } from '@/components/sheet';

const ITEMS = [
  ['Is Plasma free?', 'Yes. Plasma is free and open source under the Apache-2.0 license. The source code is on GitHub.'],
  ['Which databases can I use?', 'PostgreSQL, MySQL, MariaDB, SQLite, ClickHouse, DuckDB, Redis and OpenSearch.'],
  ['Do I need an account?', 'No. Plasma has no account system and no usage analytics.'],
  ['Is AI required?', 'No. AI stays off until you set up a provider: your own OpenRouter key, or a model that runs on your machine.'],
  [
    'Does the AI see my data?',
    'Only what you allow. The line under the message box lists what the next message carries. Table and column names and the SQL in your current tab go with it, never row values, unless you turn on row access for a connection. Rows the AI reads are masked. A Prod connection sends no schema until you opt in.',
  ],
  [
    'What is the MCP server?',
    'A server on your computer that lets Claude Code, Cursor, Codex or Claude Desktop use your SQL databases through Plasma. It is off by default and every connection starts with no access. A tool can change data only when you approve the exact statement in Plasma.',
  ],
  ['Why does macOS show a warning?', 'The builds do not have an Apple signature yet. See the macOS first start note in the download section.'],
  ['Why does Windows show a warning?', 'The builds do not have a Microsoft signature yet. Click More info, then Run anyway.'],
  [
    'Why does the Linux AppImage start without a sandbox?',
    'Some systems, such as Ubuntu 24.04 and later, restrict what the Chromium sandbox needs. The .deb installs an AppArmor profile that keeps the sandbox working. An AppImage cannot, so install the .deb if you want the sandbox.',
  ],
  [
    'Where is my data?',
    'On your computer, in Plasma’s user-data folder: ~/Library/Application Support/Plasma on macOS, %APPDATA%\\Plasma on Windows, ~/.config/Plasma on Linux. Saved passwords are in your OS keychain.',
  ],
] as const;

const POPULAR = [
  ['/docs/getting-started/', 'First connection and the workbench'],
  ['/docs/ai-assistant/', 'AI assistant'],
  ['/docs/safety-privacy/', 'Safety and privacy'],
] as const;

export function FAQ() {
  return (
    <section id="faq" aria-labelledby="faq-title" className="py-24 md:py-32">
      <div className="wrap">
        <SectionHead name="Questions" />
        <div className="mt-14 grid gap-12 lg:grid-cols-12">
          <Reveal className="lg:col-span-5">
            <h2 id="faq-title" className="display t-h2">
              Questions.
            </h2>
            <div className="mt-12 max-w-[26rem]">
              <Sheet>
                <div className="px-5 pb-6 pt-5">
                  <p className="label text-ink">Read the docs</p>
                  <p className="prose-p mt-3 text-[15.5px]">Every feature, with the exact labels and limits.</p>
                  <ul className="mt-5 border-t border-rule">
                    {POPULAR.map(([href, label]) => (
                      <li key={href} className="border-b border-rule last:border-b-0">
                        <Link
                          href={href}
                          className="group flex items-baseline justify-between gap-4 py-3 text-[15.5px] font-semibold text-ink"
                        >
                          {label}
                          <span aria-hidden="true" className="text-signal transition-transform duration-300 group-hover:translate-x-1">
                            &rarr;
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                  <Link
                    href="/docs/"
                    className="mono mt-5 inline-flex items-center gap-2 text-[12px] font-medium uppercase tracking-[0.06em] text-ink underline decoration-signal decoration-2 underline-offset-[5px] transition-colors hover:text-signal"
                  >
                    All docs
                    <span aria-hidden="true">&rarr;</span>
                  </Link>
                </div>
              </Sheet>
            </div>
          </Reveal>
          <Reveal className="lg:col-span-7" delay={80}>
            <div className="border-t border-ink">
              {ITEMS.map(([q, a]) => (
                <details key={q} className="group border-b border-rule">
                  <summary className="flex cursor-pointer items-center gap-5 rounded-none py-6 transition-colors duration-200 hover:bg-paper-2/60 focus-visible:outline-offset-[-2px]">
                    <span
                      className="flex-1 text-[20px] font-bold tracking-[-0.01em] text-ink"
                      style={{ fontVariationSettings: "'wdth' 108" }}
                    >
                      {q}
                    </span>
                    <span className="faq-plus relative mr-1 h-4 w-4 shrink-0" aria-hidden="true">
                      <span className="absolute left-0 top-1/2 h-px w-4 bg-ink" />
                      <span className="absolute left-1/2 top-0 h-4 w-px bg-ink transition-[transform,opacity] duration-300" />
                    </span>
                  </summary>
                  <p className="prose-p pb-7 pr-10">{a}</p>
                </details>
              ))}
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
