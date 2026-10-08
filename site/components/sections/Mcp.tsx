import { CaptureFrame } from '@/components/capture-frame';
import { CopyLine } from '@/components/copy-line';
import { LearnMore } from '@/components/docs/learn-more';
import { Plate, SectionHead } from '@/components/plate';
import { Reveal } from '@/components/reveal';
import { Sheet, SheetCell, SheetGrid } from '@/components/sheet';
import { cn } from '@/lib/cn';
import type { Captures } from '@/lib/captures';

const SETUP = 'claude mcp add --transport http plasma http://127.0.0.1:47321/mcp --header "Authorization: Bearer <token>"';

/** The four access levels, by the names the tools report (Settings labels them in full). `rungs` is how far up the ladder it reaches. */
const LADDER = [
  { name: 'Off', rungs: 0, body: 'Nothing. The connection is not listed, and every connection starts here.' },
  { name: 'Schema', rungs: 1, body: 'The tool sees the structure of the connection and its notes. In Settings: Structure only.' },
  { name: 'Read', rungs: 2, body: 'Also runs read-only queries, with sensitive values masked. In Settings: Structure and read queries.' },
  { name: 'Propose', rungs: 3, body: 'Also proposes one statement at a time on the connection open in Plasma. It runs only when you approve it. Not offered on read-only connections.' },
] as const;

const FACTS = [
  ['This computer only', 'The server listens on 127.0.0.1 and wants a token with every request.'],
  ['Masked by default', 'Results hide emails, phone numbers, card numbers and sensitive columns.'],
  ['No credentials leave', 'A tool never receives a password, host, user or file path.'],
] as const;

function Rungs({ n }: { n: number }) {
  return (
    <svg viewBox="0 0 44 22" className="h-[22px] w-[44px]" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <rect
          key={i}
          x={i * 16}
          y={14 - i * 6}
          width="12"
          height={8 + i * 6}
          fill={i < n ? 'var(--color-ink)' : 'none'}
          stroke={i < n ? 'var(--color-ink)' : 'var(--color-ink-3)'}
          strokeWidth="1"
        />
      ))}
    </svg>
  );
}

function Terminal() {
  return (
    <figure className="min-w-0">
      <Plate>
        <div className="flex items-center justify-between gap-4 border-b border-rule px-5 py-3 sm:px-7">
          <p className="mono text-[11.5px] tracking-[0.03em] text-ink-2">Claude Code</p>
          <span className="label rounded-full border border-ink px-2.5 py-0.5 text-[10px] text-ink">Example</span>
        </div>
        <pre
          className="mono overflow-x-auto whitespace-pre px-5 py-7 text-[12.5px] md:whitespace-pre-wrap md:break-words leading-[1.75] text-ink sm:px-7 sm:text-[13px]"
          aria-label="Example transcript of Claude Code calling four Plasma tools"
        >
          <code className="block">
            <span className="text-ink-2">plasma</span> <span className="text-ink-3">/</span> list_connections{'\n'}
            <span className="text-ink-2">{'  '}shop · postgres · propose</span>
            {'\n\n'}
            <span className="text-ink-2">plasma</span> <span className="text-ink-3">/</span> run_query{'\n'}
            <span className="text-ink-2">{'  '}select status, count(*) from orders{'\n'}{'    '}group by status</span>
            {'\n'}
            <span className="text-ink-2">{'  '}4 rows · read-only session · masked</span>
            {'\n\n'}
            <span className="text-ink-2">plasma</span> <span className="text-ink-3">/</span> propose_change{'\n'}
            <span className="text-ink-2">{'  '}update orders set status = &apos;shipped&apos;{'\n'}{'    '}where id = 1042</span>
            {'\n'}
            <span className="font-medium text-signal">{'  '}waiting_for_approval</span>
            {'\n\n'}
            <span className="text-ink-2">plasma</span> <span className="text-ink-3">/</span> check_proposal{'\n'}
            <span className="text-ink-2">{'  '}</span>
            <span className="font-medium">applied</span>
          </code>
        </pre>
      </Plate>
      <figcaption className="label mt-5 flex items-baseline gap-3">
        <span className="h-[7px] w-[7px] shrink-0 translate-y-[-1px] bg-signal" aria-hidden="true" />
        <span className="text-[12.5px] normal-case tracking-normal">
          An example, not a recording. The change waits until you answer in Plasma.
        </span>
      </figcaption>
    </figure>
  );
}

export function Mcp({ captures }: { captures: Captures }) {
  const proposal = captures['mcp-proposal'];
  const settings = captures['mcp-settings'];

  return (
    <section id="mcp" aria-labelledby="mcp-title" className="py-24 md:py-32">
      <div className="wrap">
        <SectionHead name="MCP server" />

        <div className="mt-14 grid gap-8 lg:grid-cols-12">
          <Reveal className="lg:col-span-8">
            <h2 id="mcp-title" className="display t-h2">
              Your AI tools, through Plasma&rsquo;s guardrails.
            </h2>
          </Reveal>
          <Reveal className="lg:col-span-4 lg:self-end" delay={100}>
            <p className="prose-p">
              Claude Code, Cursor, Codex and Claude Desktop can look at your SQL databases, run read-only queries
              and propose changes. Plasma asks you before any change runs.
            </p>
            <LearnMore href="/docs/mcp-server/">Set up the MCP server</LearnMore>
          </Reveal>
        </div>

        <Reveal className="mt-16 grid gap-12 lg:grid-cols-12 lg:items-start lg:gap-10 xl:gap-14" delay={60}>
          <div className={cn('min-w-0', proposal ? 'lg:col-span-5' : 'lg:col-span-12 lg:max-w-[46rem]')}>
            <Terminal />
          </div>
          {proposal && (
            <div className="lg:col-span-7">
              <CaptureFrame
                c={proposal}
                detail={{ rect: [1150, 135, 262, 322], at: [430, 150, 450], label: 'the change, waiting for you' }}
                sizes="(min-width: 1400px) 700px, (min-width: 1024px) 55vw, 100vw"
                caption="The same request in Plasma: the exact statement, waiting for you."
              />
            </div>
          )}
        </Reveal>

        <Reveal className="mt-24">
          <p className="label text-ink">Access, per connection</p>
          <Sheet className="mt-4">
            <SheetGrid as="ul" label="Access levels" className="sm:grid-cols-2 lg:grid-cols-4">
              {LADDER.map((l, i) => (
                <SheetCell as="li" key={l.name} index={i}>
                  <Rungs n={l.rungs} />
                  <span className="mt-5 block text-[22px] font-bold leading-none tracking-[-0.015em] text-ink" style={{ fontVariationSettings: "'wdth' 110" }}>
                    {l.name}
                  </span>
                  <span className="mt-3 block text-[15.5px] leading-[1.5] text-ink-2">{l.body}</span>
                </SheetCell>
              ))}
            </SheetGrid>
          </Sheet>
        </Reveal>

        <Reveal className="mt-16 grid gap-12 lg:grid-cols-12 lg:gap-10 xl:gap-14" delay={60}>
          <div className={cn('min-w-0', settings ? 'lg:col-span-7' : 'lg:col-span-12')}>
            <dl className={cn('grid gap-x-8 gap-y-8', settings ? 'sm:grid-cols-3' : 'sm:grid-cols-3')}>
              {FACTS.map(([t, d]) => (
                <div key={t} className="border-t border-ink pt-4">
                  <dt className="label text-ink">{t}</dt>
                  <dd className="mt-3 text-[15.5px] leading-[1.5] text-ink-2">{d}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-12">
              <CopyLine label="Claude Code" text={SETUP} />
              <p className="mt-3 text-[14px] leading-[1.5] text-ink-2">
                Copy the real line, with your token, from Settings &rarr; MCP server.
              </p>
            </div>
          </div>
          {settings && (
            <div className="lg:col-span-5">
              <CaptureFrame
                c={settings}
                sizes="(min-width: 1400px) 480px, (min-width: 1024px) 40vw, 100vw"
                caption="Settings: the switch, the port, your client, and the access level of each connection."
              />
            </div>
          )}
        </Reveal>
      </div>
    </section>
  );
}
