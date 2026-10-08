import { CaptureFrame } from '@/components/capture-frame';
import { LearnMore } from '@/components/docs/learn-more';
import { SectionHead } from '@/components/plate';
import { Reveal } from '@/components/reveal';
import { Sheet, SheetCell, SheetGrid } from '@/components/sheet';
import { cn } from '@/lib/cn';
import type { Captures } from '@/lib/captures';

/** What the agent can do, from the AI docs. `kind` is the tool or feature name as the app shows it. */
const ACTIONS = [
  ['show_table', 'Show a table', 'Filter, sort, pick columns, latest first. You Apply the view, and can Undo it.'],
  ['run_query', 'Run a read-only query', 'One read-only statement, such as a SELECT, in a new editor tab. It runs in a read-only session where the engine allows.'],
  ['propose_change', 'Propose a change', 'One statement with a summary. On PostgreSQL, approving previews it with Safe Run. You commit.'],
  ['open_in_editor', 'Draft SQL in the editor', 'The SQL lands in a new tab. It is not run.'],
  ['Ask', 'Ask the filter bar', 'Describe the view you want, such as the latest 10 orders. Apply it, or Undo.'],
  ['Fix and explain', 'Fix and explain errors', 'Fix with AI on a failed query, Explain with AI on a plan. Both suggest. Neither runs.'],
  ['Images', 'Paste a screenshot', 'Attach or drop up to 6 images per message, for models that read them.'],
  ['Memory', 'Remember what the schema cannot say', 'Short notes per connection, such as amounts being in cents. You approve each note it proposes.'],
] as const;

const SENT = [
  ['Schema', 'Names and types', 'Table and column names, never values. Withheld on Prod until you opt that connection in.'],
  ['Rows', 'Off by default', 'Only from connections where you turn on Let the AI read rows.'],
  ['Masking', 'Sensitive values hidden', 'Rows the agent reads are masked, and capped at 50 rows per result.'],
  ['Provider', 'Your key, or no key', 'Your own OpenRouter key, or a model on your machine with no key at all.'],
] as const;

export function Assistant({ captures }: { captures: Captures }) {
  const agent = captures['ai-agent'];
  const memory = captures['ai-memory'];

  return (
    <section id="assistant" aria-labelledby="assistant-title" className="border-t border-rule bg-paper-2/50 py-24 md:py-32">
      <div className="wrap">
        <SectionHead name="Assistant" />

        <div className="mt-14 grid gap-8 lg:grid-cols-12">
          <Reveal className="lg:col-span-8">
            <h2 id="assistant-title" className="display t-h2">
              AI that asks before it acts.
            </h2>
          </Reveal>
          <Reveal className="lg:col-span-4 lg:self-end" delay={100}>
            <p className="prose-p">
              The assistant works on your workbench through approval cards. It never changes anything by itself.
            </p>
            <LearnMore href="/docs/ai-assistant/">How the assistant works</LearnMore>
          </Reveal>
        </div>

        <div className={cn('mt-16 grid gap-14', agent && 'lg:grid-cols-12 lg:gap-10 xl:gap-14')}>
          {agent && (
            <div className="lg:col-span-7">
              <div className="lg:sticky lg:top-28">
                <Reveal>
                  <CaptureFrame
                    c={agent}
                    detail={{ rect: [1150, 440, 262, 300], at: [430, 150, 470], label: 'the approval card' }}
                    sizes="(min-width: 1400px) 700px, (min-width: 1024px) 55vw, 100vw"
                    caption="The agent proposes. You read the card, then run it or reject it."
                  />
                </Reveal>
                {memory && (
                  <Reveal className="mt-14 max-w-[78%]" delay={80}>
                    <CaptureFrame
                      c={memory}
                      sizes="(min-width: 1400px) 540px, 60vw"
                      caption="Database memory: notes about one connection, each labelled with who wrote it."
                    />
                  </Reveal>
                )}
              </div>
            </div>
          )}

          <div className={cn(agent && 'lg:col-span-5')}>
            <p className="label mb-3 text-ink">What it can do</p>
            <Sheet>
              <SheetGrid as="ul" label="What the agent can do" className={cn(agent ? 'grid-cols-1' : 'sm:grid-cols-2 xl:grid-cols-4')}>
                {ACTIONS.map(([kind, name, body], i) => (
                  <SheetCell as="li" key={name} kind={kind} index={i}>
                    <span className="mt-4 block text-[19px] font-bold leading-snug tracking-[-0.01em] text-ink" style={{ fontVariationSettings: "'wdth' 108" }}>
                      {name}
                    </span>
                    <span className="mt-2 block text-[15.5px] leading-[1.5] text-ink-2">{body}</span>
                  </SheetCell>
                ))}
              </SheetGrid>
            </Sheet>
          </div>
        </div>

        <Reveal className="mt-24">
          <div className="grid gap-6 lg:grid-cols-12 lg:items-end">
            <div className="lg:col-span-7">
              <p className="label text-ink">What is sent</p>
              <p className="t-h3 mt-3 max-w-[22em]">Only what you allow, and the line under the message box says exactly what.</p>
            </div>
            <p className="prose-p lg:col-span-5">
              Prompts and that context go to the provider you chose. Pick a model from OpenRouter&rsquo;s live list;
              the agent needs one that supports tool calling.
            </p>
          </div>
          <Sheet className="mt-8">
            <SheetGrid as="ul" label="What is sent to the AI provider" className="sm:grid-cols-2 lg:grid-cols-4">
              {SENT.map(([kind, name, body], i) => (
                <SheetCell as="li" key={kind} kind={kind} index={i}>
                  <span className="mt-4 block text-[19px] font-bold leading-snug tracking-[-0.01em] text-ink" style={{ fontVariationSettings: "'wdth' 108" }}>
                    {name}
                  </span>
                  <span className="mt-2 block text-[15.5px] leading-[1.5] text-ink-2">{body}</span>
                </SheetCell>
              ))}
            </SheetGrid>
          </Sheet>
        </Reveal>
      </div>
    </section>
  );
}
