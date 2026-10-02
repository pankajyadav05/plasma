'use client';

import Image from 'next/image';
import { useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(useGSAP, ScrollTrigger);
const engines = [
  {
    id: 'postgres',
    name: 'Postgres',
    title: 'Write SQL. Follow the relationships.',
    description:
      'A schema-aware editor beside your results, with table definitions, cell details and an EXPLAIN tree in reach.',
    features: [
      'Tables, views and foreign keys',
      'Selection, statement and script execution',
      'Individual results for multi-statement runs',
    ],
    alt: 'Actual Plasma PostgreSQL editor, schema browser and query results, using illustrative commerce data.',
  },
  {
    id: 'redis',
    name: 'Redis',
    title: 'Get closer to your keys.',
    description:
      'Browse namespaces, read values by type and inspect their TTL. Open the command line when you want to go further.',
    features: [
      'Strings, hashes, lists and more',
      'TTL and typed-value inspection',
      'CLI, memory analysis, slow log and pub/sub',
    ],
    alt: 'Actual Plasma Redis namespace browser and session hash inspector with illustrative values.',
  },
  {
    id: 'opensearch',
    name: 'OpenSearch',
    title: 'Find the document behind the event.',
    description:
      'Search with a query string or raw DSL. Choose fields for your results and expand the documents behind them.',
    features: [
      'Index and mapping inspection',
      'Query strings and JSON DSL',
      'Selectable fields and document details',
    ],
    alt: 'Actual Plasma OpenSearch index browser, field selector and document results with illustrative commerce events.',
  },
] as const;

export function EngineWorkspaces() {
  const root = useRef<HTMLDivElement>(null);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const selector = useRef<HTMLDivElement>(null);
  const indicator = useRef<HTMLSpanElement>(null);
  const previousActive = useRef(0);
  const [active, setActive] = useState(0);
  const engine = engines[active];
  useGSAP(
    () => {
      const list = selector.current;
      const line = indicator.current;
      if (!list || !line) return;
      const positionIndicator = () => {
        const button = buttons.current[active];
        if (!button) return;
        const left = button.offsetLeft;
        const width = button.offsetWidth;
        line.style.transform = `translateX(${left}px) scaleX(${width})`;
        list.dataset.measured = 'true';
      };
      positionIndicator();
      const observer = new ResizeObserver(positionIndicator);
      observer.observe(list);
      buttons.current.forEach((button) => {
        if (button) observer.observe(button);
      });
      const media = gsap.matchMedia();
      if (previousActive.current !== active) {
        media.add('(prefers-reduced-motion: no-preference)', () => {
          gsap.from('[data-engine-copy]', {
            y: 6,
            duration: 0.28,
            ease: 'power3.out',
            clearProps: 'transform',
          });
        });
      }
      previousActive.current = active;
      const refreshFrame = requestAnimationFrame(() => ScrollTrigger.refresh());
      return () => {
        cancelAnimationFrame(refreshFrame);
        observer.disconnect();
        media.revert();
      };
    },
    { scope: root, dependencies: [active], revertOnUpdate: true },
  );
  function onKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % engines.length;
    else if (event.key === 'ArrowLeft') next = (index + engines.length - 1) % engines.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = engines.length - 1;
    else return;
    event.preventDefault();
    setActive(next);
    buttons.current[next]?.focus();
  }
  return (
    <div className="engine-deck" ref={root}>
      <div className="engine-deck-top">
        <div className="engine-stack" aria-label={`${engine.name} workspace preview`}>
          {engines.map((item, index) => (
            <div
              className={`engine-sheet ${index === active ? 'is-front' : 'is-behind'}`}
              key={item.id}
              aria-hidden={index !== active}
              style={
                {
                  '--sheet-depth': (index - active + engines.length) % engines.length,
                } as React.CSSProperties
              }
            >
              <Image
                src={`/product/${item.id}.webp`}
                width={1800}
                height={1125}
                alt={index === active ? item.alt : ''}
                sizes="(max-width: 767px) 94vw, 700px"
              />
            </div>
          ))}
        </div>
        <div
          className="engine-copy"
          id="engine-view"
          role="tabpanel"
          aria-labelledby={`engine-${engine.id}`}
          tabIndex={0}
          data-engine-copy
        >
          <span className="engine-name">{engine.name}</span>
          <h3>{engine.title}</h3>
          <p>{engine.description}</p>
          <ul>
            {engine.features.map((feature) => (
              <li key={feature}>{feature}</li>
            ))}
          </ul>
          <a
            href={`/product/${engine.id}.webp`}
            className="text-action"
            target="_blank"
            rel="noreferrer"
          >
            View full workspace <ArrowUpRight aria-hidden="true" />
          </a>
        </div>
      </div>
      <div className="engine-deck-bottom">
        <div
          ref={selector}
          className="engine-selector"
          role="tablist"
          aria-label="Choose a database workspace"
        >
          {engines.map((item, index) => (
            <button
              type="button"
              role="tab"
              id={`engine-${item.id}`}
              aria-selected={active === index}
              aria-controls="engine-view"
              tabIndex={active === index ? 0 : -1}
              key={item.id}
              ref={(node) => {
                buttons.current[index] = node;
              }}
              onClick={() => setActive(index)}
              onKeyDown={(event) => onKey(event, index)}
            >
              {item.name}
            </button>
          ))}
          <span ref={indicator} className="engine-selector-indicator" aria-hidden="true" />
        </div>
        <p>Actual Plasma components. Illustrative data.</p>
      </div>
    </div>
  );
}
