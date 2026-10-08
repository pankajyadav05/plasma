import { SectionHead } from '@/components/plate';
import { Reveal } from '@/components/reveal';
import { Sheet, SheetCell, SheetGrid } from '@/components/sheet';
import { LearnMore } from '@/components/docs/learn-more';

const LEDGER = [
  ['Connections, history, settings', 'On your computer'],
  ['Saved passwords', 'Your OS keychain'],
  ['Account', 'None'],
  ['Analytics', 'None'],
  ['AI', 'Only when you use it, to the provider you chose'],
  ['Model list', 'A public request to OpenRouter when a model picker is shown. No key, no data'],
  ['MCP server', 'Off by default. This computer only'],
  ['Update check', 'Asks the update feed for the latest version'],
] as const;

export function Local() {
  return (
    <section id="local" aria-labelledby="local-title" className="py-24 md:py-32">
      <div className="wrap">
        <SectionHead name="Local-first" />

        <div className="mt-14 grid gap-16 lg:grid-cols-12 lg:gap-10">
          <div className="lg:col-span-6">
            <Reveal>
              <h2 id="local-title" className="display t-h2">
                Local-first. No account.
              </h2>
              <p className="lede mt-10 !max-w-[30em] !text-ink">
                Plasma keeps your connections, history and settings on your computer. Your OS keychain encrypts
                saved passwords.
              </p>
              <LearnMore href="/docs/safety-privacy/#leaves-machine">What leaves your machine</LearnMore>
            </Reveal>
            <Reveal className="mt-14 max-w-[32em] border-t border-rule pt-6" delay={80}>
              <p className="label text-ink">Team workspaces</p>
              <p className="prose-p mt-3">
                Keep shared connections, queries and snippets in a .plasma folder in git. Passwords stay out of the
                folder.
              </p>
            </Reveal>
          </div>

          <Reveal className="lg:col-span-6" delay={120}>
            <p className="label mb-3 text-ink">Where your data stays</p>
            <Sheet>
              <SheetGrid as="ul" label="Where your data stays">
                {LEDGER.map(([k, v], i) => (
                  <SheetCell
                    as="li"
                    key={k}
                    index={i}
                    className="grid grid-cols-1 gap-x-6 gap-y-1.5 !py-4 sm:grid-cols-[11rem_1fr] sm:items-baseline"
                  >
                    <span className="text-[16px] font-semibold text-ink">{k}</span>
                    <span className="text-[16px] text-ink-2">{v}</span>
                  </SheetCell>
                ))}
              </SheetGrid>
            </Sheet>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
