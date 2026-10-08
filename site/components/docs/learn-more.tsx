import Link from 'next/link';

/** A small "Read more in the docs" link for homepage sections. */
export function LearnMore({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="mono mt-6 inline-flex items-center gap-2 text-[12px] font-medium uppercase tracking-[0.06em] text-ink underline decoration-signal decoration-2 underline-offset-[5px] transition-colors hover:text-signal"
    >
      {children}
      <span aria-hidden="true">&rarr;</span>
    </Link>
  );
}
