'use client';

import { ArrowDown, Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { SectionHead } from '@/components/plate';
import { Reveal } from '@/components/reveal';
import { cn } from '@/lib/cn';
import { usePlatform, type DownloadVariant } from '@/lib/platform';
import { LICENSE, VERSION } from '@/lib/version';

const CMD = 'xattr -cr /Applications/Plasma.app';

function Card({ v, primary, n }: { v: DownloadVariant; primary: boolean; n: number }) {
  return (
    <div className="flex w-full">
      <a
        href={v.url}
        className={cn(
          'group relative flex w-full flex-col justify-between gap-14 rounded-[14px] border p-6 transition-[transform,box-shadow,border-color,background-color] duration-300 hover:-translate-y-1 sm:p-7',
          primary
            ? 'border-ink bg-paper-2 shadow-[0_30px_60px_-30px_rgba(22,21,15,0.3)]'
            : 'border-rule bg-paper-2/60 hover:border-ink hover:bg-paper-2 hover:shadow-[0_30px_60px_-34px_rgba(22,21,15,0.25)]',
        )}
      >
        <div className="flex items-start justify-between gap-4">
          <span className="label">Part {String(n).padStart(2, '0')}</span>
          {primary && (
            <span className="label rounded-full bg-ink px-2.5 py-0.5 text-[10px] text-paper">Your system</span>
          )}
        </div>
        <div>
          <p className="t-h3">{v.label}</p>
          <p className="mono mt-3 text-[11.5px] tracking-[0.02em] text-ink-2">
            v{VERSION} <span className="text-ink-3">·</span> {v.sizeLabel}
          </p>
          <span
            className={cn(
              'mt-7 inline-flex h-11 items-center gap-2 rounded-full px-5 text-[15px] font-bold transition-colors duration-200',
              primary
                ? 'bg-signal text-signal-ink group-hover:bg-[#b83a22]'
                : 'border border-ink/25 text-ink group-hover:border-ink group-hover:bg-ink group-hover:text-paper',
            )}
          >
            Download
            <ArrowDown className="h-4 w-4 transition-transform duration-300 group-hover:translate-y-0.5" strokeWidth={2.4} />
          </span>
        </div>
      </a>
    </div>
  );
}

export function Download() {
  const { primary, alternates } = usePlatform();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(CMD);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable: the command stays selectable */
    }
  };

  const all = [primary, ...alternates];

  return (
    <section id="download" aria-labelledby="download-title" className="border-t border-rule bg-paper-2/50 py-28 md:py-44">
      <div className="wrap">
        <SectionHead plate="Plate 06" name="Download" />

        <div className="mt-16 grid gap-8 lg:grid-cols-12">
          <Reveal className="lg:col-span-8">
            <h2 id="download-title" className="display t-h2">
              Install Plasma.
            </h2>
          </Reveal>
          <Reveal className="lg:col-span-4 lg:self-end" delay={100}>
            <p className="label">
              v{VERSION} <span className="text-ink-3">·</span> {LICENSE} <span className="text-ink-3">·</span> Free
            </p>
          </Reveal>
        </div>

        <ul className="mt-20 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {all.map((v, i) => (
            <Reveal as="li" key={v.key} delay={i * 70} className="flex">
              <Card v={v} primary={i === 0} n={i + 1} />
            </Reveal>
          ))}
        </ul>

        <Reveal className="mt-16 grid gap-6 border-t border-ink pt-6 lg:grid-cols-12" delay={80}>
          <div className="lg:col-span-5">
            <p className="label text-ink">macOS first launch</p>
            <p className="prose-p mt-3">
              Builds are unsigned for now. If macOS blocks the first launch, run:
            </p>
          </div>
          <div className="min-w-0 lg:col-span-7">
            <div className="flex items-center justify-between gap-4 rounded-[14px] border border-rule bg-paper-2 py-2 pl-5 pr-2">
              <code className="mono min-w-0 overflow-x-auto whitespace-nowrap py-2 text-[13px] text-ink">{CMD}</code>
              <button
                type="button"
                onClick={copy}
                className="mono inline-flex h-10 shrink-0 items-center gap-2 rounded-full border border-ink/20 px-4 text-[11.5px] font-medium text-ink transition-colors duration-200 hover:border-ink hover:bg-ink hover:text-paper"
              >
                {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
                {copied ? 'Copied' : 'Copy'}
                <span className="sr-only" aria-live="polite">
                  {copied ? 'Command copied to clipboard' : ''}
                </span>
              </button>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
