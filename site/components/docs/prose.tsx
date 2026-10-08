import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function P({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('my-4 text-pretty text-[16.5px] leading-[1.7] text-ink-2', className)}>{children}</p>;
}

export function UL({ children }: { children: ReactNode }) {
  return (
    <ul className="my-4 list-disc space-y-2 pl-6 text-[16.5px] leading-[1.65] text-ink-2 marker:text-ink-3">
      {children}
    </ul>
  );
}

export function OL({ children }: { children: ReactNode }) {
  return (
    <ol className="my-4 list-decimal space-y-2 pl-6 text-[16.5px] leading-[1.65] text-ink-2 marker:font-semibold marker:text-ink-3">
      {children}
    </ol>
  );
}

export function LI({ children }: { children: ReactNode }) {
  return <li className="pl-1">{children}</li>;
}

/** Inline code: a setting name, a SQL keyword, a file name. */
export function C({ children }: { children: ReactNode }) {
  return (
    <code className="mono rounded-[5px] border border-rule bg-paper-2 px-[5px] py-[1px] text-[0.86em] text-ink [overflow-wrap:anywhere]">
      {children}
    </code>
  );
}

/** A label copied from the app: a button, menu item or setting. */
export function UI({ children }: { children: ReactNode }) {
  return <strong className="font-semibold text-ink">{children}</strong>;
}

export function B({ children }: { children: ReactNode }) {
  return <strong className="font-semibold text-ink">{children}</strong>;
}

/** Link to another docs page (or any internal path) or an external URL. */
export function A({ href, children }: { href: string; children: ReactNode }) {
  const cls =
    'font-medium text-ink underline decoration-signal decoration-2 underline-offset-[3px] transition-colors hover:text-signal';
  if (/^https?:\/\//.test(href)) {
    return (
      <a href={href} className={cls} rel="noreferrer">
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={cls}>
      {children}
    </Link>
  );
}

/** Link to a docs page by slug and optional anchor. */
export function Doc({ to, children }: { to: string; children: ReactNode }) {
  const [slug, hash] = to.split('#');
  return <A href={`/docs/${slug}/${hash ? `#${hash}` : ''}`}>{children}</A>;
}
