import Link from 'next/link';
import { GITHUB_URL, GithubIcon } from '@/components/github-icon';
import { Wordmark } from '@/components/wordmark';

/** The docs have their own header, so no homepage anchors are needed here. */
export function DocsHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-rule bg-paper/90 backdrop-blur-md">
      <div className="wrap flex h-16 items-center justify-between gap-4">
        <div className="flex items-baseline gap-4">
          <Link href="/" className="rounded-sm" aria-label="Plasma, home">
            <Wordmark className="text-[26px]" />
          </Link>
          <Link
            href="/docs/"
            aria-current="page"
            className="mono hidden text-[12px] font-medium uppercase tracking-[0.06em] text-ink sm:inline"
          >
            Docs
          </Link>
        </div>
        <nav aria-label="Site" className="flex items-center gap-1 sm:gap-2">
          <Link
            href="/docs/"
            className="mono rounded-full px-3 py-2 text-[12px] font-medium uppercase tracking-[0.06em] text-ink-2 hover:text-ink sm:hidden"
          >
            Docs
          </Link>
          <a
            href={GITHUB_URL}
            aria-label="Plasma on GitHub"
            className="grid h-10 w-10 place-items-center rounded-full text-ink-2 transition-colors hover:bg-ink/[0.06] hover:text-ink"
          >
            <GithubIcon className="h-[19px] w-[19px]" />
          </a>
          <Link
            href="/#download"
            className="inline-flex h-10 items-center rounded-full bg-signal px-5 text-[15px] font-bold text-signal-ink transition-[transform,background-color] duration-200 hover:bg-[#b83a22] active:scale-[0.97]"
          >
            Download
          </Link>
        </nav>
      </div>
    </header>
  );
}
