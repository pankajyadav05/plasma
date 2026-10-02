'use client';

import Image from 'next/image';
import { useRef } from 'react';
import { ArrowUpRight } from 'lucide-react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import styles from './query-journey.module.css';

const desktopRoute =
  'M1140 0 V370 Q1140 450 1060 450 H180 Q100 450 100 530 V880 Q100 960 180 960 H1060 Q1140 960 1140 1040 V1430';

export function QueryJourney() {
  const section = useRef<HTMLElement>(null);
  const route = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      gsap.registerPlugin(ScrollTrigger);
      const media = gsap.matchMedia();
      const steps = Array.from(section.current?.querySelectorAll<HTMLElement>('article') ?? []);
      steps.forEach((step) => {
        ScrollTrigger.create({
          trigger: step,
          start: 'top 55%',
          end: 'bottom 45%',
          onToggle: ({ isActive }) => {
            step.dataset.current = String(isActive);
            if (isActive) step.setAttribute('aria-current', 'step');
            else step.removeAttribute('aria-current');
          },
        });
      });

      media.add('(prefers-reduced-motion: no-preference)', () => {
        if (!section.current || !route.current) return;

        gsap.fromTo(
          section.current.querySelectorAll('[data-journey-path]'),
          { strokeDasharray: '1 1', strokeDashoffset: 1 },
          {
            strokeDashoffset: 0,
            autoRound: false,
            ease: 'none',
            scrollTrigger: {
              trigger: route.current,
              start: 'top 75%',
              end: 'bottom 75%',
              scrub: 0.8,
              invalidateOnRefresh: true,
            },
          },
        );

        section.current.querySelectorAll<HTMLElement>('[data-journey-image]').forEach((image) => {
          // Already-read content stays visible on hydration or a restored scroll position.
          if (image.getBoundingClientRect().top < window.innerHeight * 0.92) return;

          gsap.from(image, {
            y: 32,
            opacity: 0,
            duration: 0.65,
            ease: 'power2.out',
            clearProps: 'transform,opacity',
            scrollTrigger: {
              trigger: image,
              start: 'top 92%',
              once: true,
            },
          });
        });
      });

      return () => {
        media.revert();
        steps.forEach((step) => {
          delete step.dataset.current;
          step.removeAttribute('aria-current');
        });
      };
    },
    { scope: section },
  );

  return (
    <section
      ref={section}
      className={styles.section}
      id="journey"
      aria-labelledby="query-journey-title"
    >
      <div className="shell">
        <header className={styles.header}>
          <h2 id="query-journey-title">Follow the question.</h2>
          <p>
            From the shape of your schema to the work behind a query. Keep the investigation in
            Plasma.
          </p>
        </header>

        <div ref={route} className={styles.journey}>
          <svg
            className={styles.desktopRoute}
            viewBox="0 0 1240 1430"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path className={styles.routeGuide} d={desktopRoute} />
            <path className={styles.routeInk} d={desktopRoute} pathLength={1} data-journey-path />
          </svg>
          <svg
            className={styles.mobileRoute}
            viewBox="0 0 16 1000"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path className={styles.routeGuide} d="M8 0 V1000" />
            <path className={styles.routeInk} d="M8 0 V1000" pathLength={1} data-journey-path />
          </svg>

          <article className={styles.proof} aria-labelledby="journey-schema-title">
            <div className={styles.copy}>
              <h3 id="journey-schema-title">Start with the schema.</h3>
              <p>
                Browse tables and views. Write SQL with schema-aware completion, with the structure
                of your database close at hand.
              </p>
            </div>
            <figure className={styles.figure} data-journey-image>
              <div className={`${styles.frame} ${styles.schemaFrame}`}>
                <div className={styles.schemaCrop}>
                  <Image
                    src="/product/postgres.webp"
                    alt="Plasma PostgreSQL schema sidebar beside a SQL query joining orders and customers."
                    width={1800}
                    height={1125}
                    sizes="(max-width: 899px) 150vw, 1190px"
                    loading="lazy"
                  />
                </div>
              </div>
              <figcaption>
                <span>Postgres workspace · Illustrative data</span>
                <a
                  href="/product/postgres.webp"
                  target="_blank"
                  rel="noreferrer"
                  aria-label="View full-size PostgreSQL workspace image (opens in a new tab)"
                >
                  View full size <ArrowUpRight size={14} aria-hidden="true" />
                </a>
              </figcaption>
            </figure>
          </article>

          <article
            className={`${styles.proof} ${styles.results}`}
            aria-labelledby="journey-results-title"
          >
            <div className={styles.copy}>
              <h3 id="journey-results-title">Look beyond the cell.</h3>
              <p>
                Read typed results, inspect cell details and follow foreign keys. Keep exploring the
                relationships behind each row.
              </p>
            </div>
            <figure className={styles.figure} data-journey-image>
              <div className={`${styles.frame} ${styles.resultsFrame}`}>
                <div className={styles.resultsCrop}>
                  <Image
                    src="/product/postgres.webp"
                    alt="A cropped Plasma result grid showing order IDs, customer names, statuses and typed columns."
                    width={1800}
                    height={1125}
                    sizes="(max-width: 899px) 115vw, 840px"
                    loading="lazy"
                  />
                </div>
              </div>
              <figcaption>
                <span>Result grid · Illustrative data</span>
                <a
                  href="/product/postgres.webp"
                  target="_blank"
                  rel="noreferrer"
                  aria-label="View full-size PostgreSQL result image (opens in a new tab)"
                >
                  View full size <ArrowUpRight size={14} aria-hidden="true" />
                </a>
              </figcaption>
            </figure>
          </article>

          <article className={styles.proof} aria-labelledby="journey-explain-title">
            <div className={styles.copy}>
              <h3 id="journey-explain-title">Read the execution plan.</h3>
              <p>
                Inspect EXPLAIN ANALYZE as a tree. Compare estimated and actual rows, and see where
                the query spends its time. ANALYZE runs the query, including mutations.
              </p>
            </div>
            <figure className={styles.figure} data-journey-image>
              <div className={`${styles.frame} ${styles.explainFrame}`}>
                <Image
                  src="/product/explain.webp"
                  alt="Plasma EXPLAIN ANALYZE tree with Limit, Sort, Hash Join and Seq Scan nodes, showing estimated and actual rows."
                  width={1120}
                  height={593}
                  sizes="(max-width: 899px) 90vw, 700px"
                  loading="lazy"
                />
              </div>
              <figcaption>
                <span>Execution plan · Illustrative data, not a benchmark</span>
                <a
                  href="/product/explain.webp"
                  target="_blank"
                  rel="noreferrer"
                  aria-label="View full-size execution plan image (opens in a new tab)"
                >
                  View full size <ArrowUpRight size={14} aria-hidden="true" />
                </a>
              </figcaption>
            </figure>
          </article>
        </div>
      </div>
    </section>
  );
}
