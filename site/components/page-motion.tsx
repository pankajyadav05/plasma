'use client';

import { useRef, type ReactNode } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { useGSAP } from '@gsap/react';

gsap.registerPlugin(useGSAP, ScrollTrigger);

export function PageMotion({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      const media = gsap.matchMedia();
      media.add('(prefers-reduced-motion: no-preference)', () => {
        gsap.from('[data-hero-line]', {
          yPercent: 100,
          duration: 1.05,
          stagger: 0.13,
          ease: 'power4.out',
          clearProps: 'transform',
        });
        gsap.from('[data-hero-copy]', {
          y: 22,
          opacity: 0,
          duration: 0.8,
          stagger: 0.12,
          delay: 0.25,
          ease: 'power3.out',
          clearProps: 'transform,opacity',
        });
        gsap.from('[data-hero-image]', {
          scale: 0.985,
          duration: 0.8,
          ease: 'power3.out',
          clearProps: 'transform',
        });
        root.current?.querySelectorAll<HTMLElement>('[data-section-heading]').forEach((heading) => {
          gsap.from(heading, {
            y: 28,
            duration: 0.85,
            ease: 'power3.out',
            scrollTrigger: { trigger: heading, start: 'top 90%', once: true },
            clearProps: 'transform,opacity',
          });
        });
        gsap
          .timeline({
            scrollTrigger: {
              trigger: '.route-board',
              start: 'top 85%',
              end: 'bottom 45%',
              scrub: 0.6,
            },
          })
          .from('.route-fill', {
            scaleX: 0,
            transformOrigin: 'left center',
            stagger: 0.2,
            duration: 1,
            ease: 'none',
          });
        gsap.from('[data-wordmark]', {
          yPercent: 25,
          duration: 1.2,
          ease: 'power4.out',
          scrollTrigger: { trigger: '.footer-wordmark', start: 'top 90%', once: true },
          clearProps: 'transform,opacity',
        });
      });
      media.add('(min-width: 800px) and (prefers-reduced-motion: no-preference)', () => {
        gsap.to('[data-hero-visual]', {
          y: -24,
          ease: 'none',
          scrollTrigger: {
            trigger: '.hero',
            start: 'top top',
            end: 'bottom top',
            scrub: 0.6,
          },
        });
        gsap.from('.engine-stack', {
          y: 38,
          scale: 0.975,
          ease: 'none',
          scrollTrigger: {
            trigger: '.engine-deck',
            start: 'top 85%',
            end: 'top 35%',
            scrub: 0.65,
          },
        });
      });
      return () => media.revert();
    },
    { scope: root },
  );
  return <div ref={root}>{children}</div>;
}
