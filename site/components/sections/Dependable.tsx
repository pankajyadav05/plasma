import { CaptureFrame } from '@/components/capture-frame';
import { LearnMore } from '@/components/docs/learn-more';
import { SectionHead } from '@/components/plate';
import { Reveal } from '@/components/reveal';
import { Sheet, SheetCell, SheetGrid } from '@/components/sheet';
import type { Captures } from '@/lib/captures';

const ITEMS = [
  ['Recover', 'Crash recovery', 'Tabs, unsaved SQL and staged edits come back after a crash or a power cut. Restoring never runs a statement.'],
  ['Status', 'Clear query status', 'Queued, running, cancelling, cancelled. A write whose answer never arrived says outcome unknown, and is not repeated.'],
  ['Diagnose', 'Plain-language connection errors', 'A failed connection says what is wrong and what to try, and highlights the field to fix when there is one.'],
  ['Support', 'Support bundle', 'Lists every file and shows its text. You review all of it before saving. Nothing is uploaded.'],
  ['Update', 'One-click updates', 'Downloads in the background. Click restart and you are back where you were. Manifests are signed.'],
  ['Verify', 'A shared driver test suite', 'Every SQL driver runs the same conformance scenarios; Redis and OpenSearch have their own. Skipping one needs a stated reason.'],
] as const;

export function Dependable({ captures }: { captures: Captures }) {
  const diagnosis = captures.diagnosis;
  const recovery = captures.recovery;
  const shots = diagnosis || recovery;

  return (
    <section id="dependable" aria-labelledby="dependable-title" className="py-24 md:py-32">
      <div className="wrap">
        <SectionHead name="Dependable" />

        <div className="mt-14 grid gap-10 lg:grid-cols-12 lg:items-end lg:gap-10 xl:gap-16">
          <Reveal className="lg:col-span-7">
            <h2 id="dependable-title" className="display t-h2">
              Built to be trusted with real data.
            </h2>
          </Reveal>
          <Reveal className="lg:col-span-4 lg:col-start-9" delay={100}>
            <p className="lede">
              Laptops sleep, networks drop and apps crash. Plasma plans for it, and tells you plainly what happened.
            </p>
            <LearnMore href="/docs/reliability/">Reliability and support</LearnMore>
          </Reveal>
        </div>

        <Reveal className="mt-16">
          <Sheet>
            <SheetGrid as="ul" label="What makes Plasma dependable" className="sm:grid-cols-2 lg:grid-cols-3">
              {ITEMS.map(([kind, name, body], i) => (
                <SheetCell as="li" key={name} kind={kind} index={i}>
                  <span className="mt-4 block text-[19px] font-bold leading-snug tracking-[-0.01em] text-ink" style={{ fontVariationSettings: "'wdth' 108" }}>
                    {name}
                  </span>
                  <span className="mt-2 block text-[15.5px] leading-[1.5] text-ink-2">{body}</span>
                </SheetCell>
              ))}
            </SheetGrid>
          </Sheet>
        </Reveal>

        {shots && (
          <div className="mt-20 grid gap-14 md:grid-cols-2 md:gap-10">
            <Reveal>
              <CaptureFrame
                c={diagnosis}
                detail={{ rect: [262, 675, 788, 172], at: [150, 150, 1000], label: 'what failed, and what to try' }}
                sizes="(min-width: 1400px) 620px, (min-width: 768px) 45vw, 100vw"
                caption="A failed connection test: the step that failed, why, and what to try."
              />
            </Reveal>
            <Reveal delay={80}>
              <CaptureFrame
                c={recovery}
                detail={{ rect: [1085, 770, 340, 118], at: [380, 330, 640], label: 'what came back' }}
                sizes="(min-width: 1400px) 620px, (min-width: 768px) 45vw, 100vw"
                caption="After a crash: the notice names what came back."
              />
            </Reveal>
          </div>
        )}
      </div>
    </section>
  );
}
