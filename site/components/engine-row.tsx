import type { CSSProperties } from 'react';
import { ENGINE_MARKS, ENGINE_VIEWBOX } from '@/lib/engine-marks';

/** The databases Plasma connects to, as a logo row. Brand colour on hover. */
const ENGINES: { key: keyof typeof ENGINE_MARKS; name: string; color: string }[] = [
  { key: 'postgres', name: 'PostgreSQL', color: 'var(--color-pg)' },
  { key: 'mysql', name: 'MySQL', color: 'var(--color-mysql)' },
  { key: 'mariadb', name: 'MariaDB', color: 'var(--color-mariadb)' },
  { key: 'sqlite', name: 'SQLite', color: 'var(--color-sqlite)' },
  { key: 'clickhouse', name: 'ClickHouse', color: 'var(--color-clickhouse)' },
  { key: 'duckdb', name: 'DuckDB', color: 'var(--color-duckdb)' },
  { key: 'redis', name: 'Redis', color: 'var(--color-redis)' },
  { key: 'opensearch', name: 'OpenSearch', color: 'var(--color-os)' },
];

function Logo({ e, i }: { e: (typeof ENGINES)[number]; i: number }) {
  return (
    <span
      className="engine-logo"
      style={{ '--brand': e.color, '--i': i } as CSSProperties}
    >
      <svg viewBox={ENGINE_VIEWBOX[e.key] ?? '0 0 24 24'} aria-hidden="true" focusable="false" className="h-[26px] w-[26px] shrink-0 md:h-7 md:w-7">
        <path d={ENGINE_MARKS[e.key]} fill="currentColor" />
      </svg>
      <span className="whitespace-nowrap text-[17px] font-bold tracking-[-0.01em] md:text-[18px]">{e.name}</span>
    </span>
  );
}

export function EngineRow() {
  return (
    <div className="engine-row mt-12 border-y border-rule md:mt-16">
      {/* Wide screens: one still row across the page. */}
      <ul aria-label="Databases Plasma connects to" className="engine-still hidden items-center justify-between gap-6 py-7 min-[1400px]:flex">
        {ENGINES.map((e, i) => (
          <li key={e.key}>
            <Logo e={e} i={i} />
          </li>
        ))}
      </ul>
      {/* Smaller screens: the same row, looping slowly. Still and wrapped when motion is reduced. */}
      <div className="engine-marquee relative overflow-hidden py-6 min-[1400px]:hidden">
        <ul aria-label="Databases Plasma connects to" className="engine-track flex w-max items-center gap-10 pr-10">
          {ENGINES.map((e, i) => (
            <li key={e.key}>
              <Logo e={e} i={i} />
            </li>
          ))}
          {ENGINES.map((e, i) => (
            <li key={`${e.key}-again`} aria-hidden="true" className="engine-copy">
              <Logo e={e} i={i} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
