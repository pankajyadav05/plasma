import { SectionHead } from '@/components/plate';
import { Reveal } from '@/components/reveal';
import { LearnMore } from '@/components/docs/learn-more';

const LEDGER = [
  ['Connections', 'On your computer'],
  ['Query history', 'On your computer'],
  ['Settings', 'On your computer'],
  ['Saved passwords', 'Encrypted by your OS keychain'],
  ['Account', 'Not necessary'],
  ['AI prompts', 'Sent only when you use AI'],
] as const;

export function Local() {
  return (
    <section id="local" aria-labelledby="local-title" className="py-24 md:py-32">
      <div className="wrap">
        <SectionHead plate="Plate 05" name="Local-first" />

        <div className="mt-14 grid gap-16 lg:grid-cols-12 lg:gap-10">
          <div className="lg:col-span-7">
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
            <div className="mt-14 grid max-w-[40em] gap-10 sm:grid-cols-2">
              <Reveal className="border-t border-rule pt-6" delay={80}>
                <p className="label text-ink">Team workspaces</p>
                <p className="prose-p mt-3">
                  Keep shared connections, queries and snippets in a .plasma folder in git. Passwords stay out of
                  the folder.
                </p>
              </Reveal>
              <Reveal className="border-t border-rule pt-6" delay={140}>
                <p className="label text-ink">AI is optional</p>
                <p className="prose-p mt-3">
                  You supply your own OpenRouter key. Plasma sends row data only from connections where you allow
                  it.
                </p>
              </Reveal>
            </div>
          </div>

          <Reveal className="lg:col-span-5" delay={120}>
            <p className="label border-b border-ink pb-3">Where your data stays</p>
            <dl>
              {LEDGER.map(([k, v], i) => (
                <div
                  key={k}
                  className="grid grid-cols-[2.75rem_1fr] items-baseline gap-x-3 border-b border-rule py-4 sm:grid-cols-[2.75rem_9.5rem_1fr]"
                >
                  <span aria-hidden="true" className="mono row-span-2 text-[11.5px] text-ink-2 sm:row-span-1">
                    05.{i + 1}
                  </span>
                  <dt className="text-[16px] font-semibold text-ink">{k}</dt>
                  <dd className="col-start-2 text-[16px] text-ink-2 sm:col-start-3">{v}</dd>
                </div>
              ))}
            </dl>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
