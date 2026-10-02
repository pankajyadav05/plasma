import { SectionHead } from '@/components/plate';
import { Reveal } from '@/components/reveal';

const LEDGER = [
  ['Connections', 'On your machine'],
  ['History', 'On your machine'],
  ['Preferences', 'On your machine'],
  ['Saved passwords', 'Encrypted with your OS keychain'],
  ['Account', 'None'],
  ['AI prompts', 'Only when you use AI, to your provider'],
] as const;

export function Local() {
  return (
    <section id="local" aria-labelledby="local-title" className="py-28 md:py-44">
      <div className="wrap">
        <SectionHead plate="Plate 05" name="Local-first" />

        <div className="mt-16 grid gap-16 lg:grid-cols-12 lg:gap-10">
          <div className="lg:col-span-7">
            <Reveal>
              <h2 id="local-title" className="display t-h2">
                Local-first. No account.
              </h2>
              <p className="lede mt-10 !max-w-[30em] !text-ink">
                Your connections, history and preferences live on your machine. Saved passwords are encrypted with
                your OS keychain. There&apos;s no account and no telemetry dashboard.
              </p>
            </Reveal>
            <Reveal className="mt-14 max-w-[34em] border-t border-rule pt-6" delay={80}>
              <p className="label text-ink">AI, optional</p>
              <p className="prose-p mt-3">
                AI is optional and bring-your-own-key (OpenRouter). When you use it, your prompt and the context you
                include go to that provider. Row data is shared only on connections where you allow it.
              </p>
            </Reveal>
          </div>

          <Reveal className="lg:col-span-5" delay={120}>
            <p className="label border-b border-ink pb-3">Register of where things live</p>
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
