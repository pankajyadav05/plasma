import Image from 'next/image';
import { Plate, SectionHead } from '@/components/plate';
import { Reveal } from '@/components/reveal';
import type { CaptureKey, Captures } from '@/lib/captures';
import { LearnMore } from '@/components/docs/learn-more';

const FEATURED: {
  name: string;
  part: string;
  chip: string;
  shot: CaptureKey;
  points: string[];
}[] = [
  {
    name: 'Postgres',
    part: 'PG',
    chip: 'bg-pg',
    shot: 'pg-workbench',
    points: ['Schema-aware SQL editor', 'EXPLAIN plans', 'Health advisor', 'Backup, restore and roles'],
  },
  {
    name: 'Redis',
    part: 'RD',
    chip: 'bg-redis',
    shot: 'redis',
    points: [
      'Key browser with typed editors',
      'TTL, rename and bulk delete',
      'CLI with a policy for dangerous commands',
      'Memory analysis and live keyspace events',
    ],
  },
  {
    name: 'OpenSearch',
    part: 'OS',
    chip: 'bg-os',
    shot: 'opensearch',
    points: [
      'Cluster health, nodes and indices',
      'Document browser and editor',
      'Query console with a write policy',
      'Basic, API key and AWS SigV4 authentication',
    ],
  },
];

const MORE: { name: string; chip: string; spec: string }[] = [
  { name: 'MySQL · MariaDB', chip: 'bg-mysql', spec: 'Tables, grid editing and EXPLAIN.' },
  { name: 'SQLite', chip: 'bg-sqlite', spec: 'Open a database file. Make a backup copy.' },
  { name: 'ClickHouse', chip: 'bg-clickhouse', spec: 'Run analytics queries on large tables.' },
  { name: 'DuckDB', chip: 'bg-duckdb', spec: 'Query CSV, Parquet, JSON and Excel files with SQL.' },
];

export function Engines({ captures }: { captures: Captures }) {
  return (
    <section id="engines" aria-labelledby="engines-title" className="border-t border-rule bg-paper-2/50 py-24 md:py-32">
      <div className="wrap">
        <SectionHead plate="Plate 02" name="Engines" />
        <div className="mt-14 grid gap-8 lg:grid-cols-12">
          <Reveal className="lg:col-span-8">
            <h2 id="engines-title" className="display t-h2">
              Seven engines. One workbench.
            </h2>
          </Reveal>
          <Reveal className="lg:col-span-4 lg:self-end" delay={100}>
            <p className="prose-p">Each engine gets the tools it needs. The keys and the guardrails stay the same.</p>
            <LearnMore href="/docs/connections/">Connect to your database</LearnMore>
          </Reveal>
        </div>

        <ul className="mt-16 grid gap-14 md:grid-cols-3 md:gap-8 lg:gap-12">
          {FEATURED.map((e, i) => {
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
                        className="h-full w-full max-w-none object-cover object-left-top"
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

        <Reveal className="mt-20" delay={80}>
          <p className="label border-b border-ink pb-3">Also in the workbench</p>
          <ul className="grid sm:grid-cols-2 lg:grid-cols-4">
            {MORE.map((e, i) => (
              <li
                key={e.name}
                className="border-b border-rule py-6 sm:pr-8 lg:border-b-0 lg:border-r lg:px-6 lg:first:pl-0 lg:last:border-r-0"
              >
                <p className="flex items-center gap-2.5">
                  <span className={`h-2 w-2 rounded-full ${e.chip}`} aria-hidden="true" />
                  <span className="label text-ink-2">02.{FEATURED.length + i + 1}</span>
                </p>
                <h3
                  className="mt-3 text-[20px] font-bold tracking-[-0.01em] text-ink"
                  style={{ fontVariationSettings: "'wdth' 108" }}
                >
                  {e.name}
                </h3>
                <p className="mt-2 text-[15.5px] leading-[1.5] text-ink-2">{e.spec}</p>
              </li>
            ))}
          </ul>
        </Reveal>
      </div>
    </section>
  );
}
