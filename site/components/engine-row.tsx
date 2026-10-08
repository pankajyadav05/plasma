import type { CSSProperties } from 'react';
import { ENGINE_MARKS, ENGINE_VIEWBOX } from '@/lib/engine-marks';

/**
 * The databases Plasma connects to, drawn as a ruled spec sheet: one cell per
 * engine, hairlines between them and drafting crosses at the corners. On load
 * a signal line runs along the top rule and each mark comes on as it passes.
 */
const ENGINES: { key: keyof typeof ENGINE_MARKS; name: string; kind: string; color: string }[] = [
  { key: 'postgres', name: 'PostgreSQL', kind: 'Relational', color: 'var(--color-pg)' },
  { key: 'mysql', name: 'MySQL', kind: 'Relational', color: 'var(--color-mysql)' },
  { key: 'mariadb', name: 'MariaDB', kind: 'Relational', color: 'var(--color-mariadb)' },
  { key: 'sqlite', name: 'SQLite', kind: 'Embedded', color: 'var(--color-sqlite)' },
  { key: 'clickhouse', name: 'ClickHouse', kind: 'Columnar', color: 'var(--color-clickhouse)' },
  { key: 'duckdb', name: 'DuckDB', kind: 'Analytical', color: 'var(--color-duckdb)' },
  { key: 'redis', name: 'Redis', kind: 'Key-value', color: 'var(--color-redis)' },
  { key: 'opensearch', name: 'OpenSearch', kind: 'Search', color: 'var(--color-os)' },
];

function Cross({ className }: { className: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 11 11" className={`engine-cross absolute h-[11px] w-[11px] ${className}`}>
      <path d="M5.5 0v11M0 5.5h11" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

export function EngineRow() {
  return (
    <div className="engine-sheet relative mt-12 md:mt-16">
      <Cross className="-left-[5px] -top-[6px]" />
      <Cross className="-right-[5px] -top-[6px]" />
      <Cross className="-bottom-[6px] -left-[5px]" />
      <Cross className="-bottom-[6px] -right-[5px]" />
      <span aria-hidden="true" className="engine-wire" />

      <ul aria-label="Databases Plasma connects to" className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8">
        {ENGINES.map((e, i) => (
          <li key={e.key} className="engine-cell relative" style={{ '--brand': e.color, '--i': i } as CSSProperties}>
            <span aria-hidden="true" className="engine-bar" />
            <span className="engine-kind mono block truncate text-[10.5px] font-medium uppercase leading-none tracking-[0.08em] text-ink-3">
              {e.kind}
            </span>
            <span className="engine-name mt-4 flex flex-col items-start gap-3 md:mt-5">
              <svg
                viewBox={ENGINE_VIEWBOX[e.key] ?? '0 0 24 24'}
                aria-hidden="true"
                focusable="false"
                className="engine-mark h-7 w-7 shrink-0 md:h-8 md:w-8"
              >
                <path d={ENGINE_MARKS[e.key]} fill="currentColor" />
              </svg>
              <span className="whitespace-nowrap text-[16px] font-bold leading-none tracking-[-0.015em] text-ink md:text-[17px]">{e.name}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
