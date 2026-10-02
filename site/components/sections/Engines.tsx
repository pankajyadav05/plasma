import Image from 'next/image';
import { Plate, SectionHead } from '@/components/plate';
import { Reveal } from '@/components/reveal';
import type { CaptureKey, Captures } from '@/lib/captures';

const ENGINES: {
  name: string;
  part: string;
  chip: string;
  shot: CaptureKey;
  pos: string;
  points: string[];
}[] = [
  {
    name: 'Postgres',
    part: 'PG',
    chip: 'bg-pg',
    shot: 'pg-workbench',
    pos: 'object-left-top',
    points: [
      'Schema-aware editor',
      'EXPLAIN view',
      'Structure editing & ER diagram',
      'Import, backup & restore',
      'Roles & privileges',
    ],
  },
  {
    name: 'Redis',
    part: 'RD',
    chip: 'bg-redis',
    shot: 'redis',
    pos: 'object-left-top',
    points: [
      'Key browser with SCAN and patterns',
      'Typed editors for strings, hashes, lists, sets, sorted sets and streams',
      'TTL, rename and bulk delete',
      'CLI with a dangerous-command policy',
      'Memory analyzer, slow log, pub/sub',
    ],
  },
  {
    name: 'OpenSearch',
    part: 'OS',
    chip: 'bg-os',
    shot: 'opensearch',
    pos: 'object-left-top',
    points: [
      'Cluster health, nodes and indices',
      'Create indices with mappings',
      'Browse, edit and delete documents',
      'Query console with a write policy',
      'Basic, API-key and AWS SigV4 auth',
    ],
  },
];

export function Engines({ captures }: { captures: Captures }) {
  return (
    <section id="engines" aria-labelledby="engines-title" className="border-t border-rule bg-paper-2/50 py-28 md:py-44">
      <div className="wrap">
        <SectionHead plate="Plate 02" name="Engines" />
        <div className="mt-16 grid gap-8 lg:grid-cols-12">
          <Reveal className="lg:col-span-8">
            <h2 id="engines-title" className="display t-h2">
              Three engines. One way of working.
            </h2>
          </Reveal>
          <Reveal className="lg:col-span-4 lg:self-end" delay={100}>
            <p className="prose-p">
              Each engine gets its own workspace, with the tools that engine actually needs, inside the same quiet
              window.
            </p>
          </Reveal>
        </div>

        <ul className="mt-20 grid gap-14 md:grid-cols-3 md:gap-8 lg:gap-12">
          {ENGINES.map((e, i) => {
            const c = captures[e.shot];
            return (
              <Reveal as="li" key={e.name} delay={i * 90} className="flex">
                <article className="group flex w-full flex-col">
                  <Plate frameClassName="transition-[transform,box-shadow] duration-500 ease-out group-hover:-translate-y-1 group-hover:shadow-[0_40px_70px_-30px_rgba(22,21,15,0.32)]">
                    <div className="relative aspect-[4/5] overflow-hidden">
                      <Image
                        src={c.src}
                        alt={c.alt}
                        width={c.width}
                        height={c.height}
                        loading="lazy"
                        sizes="(min-width: 1024px) 420px, (min-width: 768px) 33vw, 100vw"
                        className={`h-full w-full max-w-none object-cover ${e.pos}`}
                      />
                    </div>
                  </Plate>
                  <div className="mt-8 flex items-center gap-3">
                    <span className="mono inline-flex items-center gap-2 rounded-full border border-rule bg-paper-2 py-1 pl-2 pr-3 text-[11px] font-medium tracking-[0.04em] text-ink">
                      <span className={`h-2 w-2 rounded-full ${e.chip}`} aria-hidden="true" />
                      {e.part}
                    </span>
                    <span className="label">Plate 02.{i + 1}</span>
                  </div>
                  <h3 className="t-h3 mt-4">{e.name}</h3>
                  <ul className="mt-5 border-t border-rule">
                    {e.points.map((p) => (
                      <li
                        key={p}
                        className="mono border-b border-rule py-3 text-[12px] leading-[1.55] tracking-[0.01em] text-ink-2"
                      >
                        {p}
                      </li>
                    ))}
                  </ul>
                </article>
              </Reveal>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
