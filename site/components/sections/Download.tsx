'use client';

import { ArrowDown, Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { SectionHead } from '@/components/plate';
import { Reveal } from '@/components/reveal';
import { cn } from '@/lib/cn';
import type { DownloadVariant, Os } from '@/lib/feed';
import { usePlatform } from '@/lib/platform';

const CMD = 'xattr -cr /Applications/Plasma.app';

const OS_NAME: Record<Os, string> = { mac: 'macOS', win: 'Windows', linux: 'Linux' };
const OS_ARCH: Record<Os, string> = { mac: 'Apple Silicon', win: 'x64', linux: 'x64' };
/** Short names for the secondary files under the main button. */
const SHORT: Record<string, string> = {
  'win-portable': 'Portable EXE',
  'linux-deb': '.deb package',
  'win-installer': 'Installer',
  'linux-appimage': 'AppImage',
  'mac-arm64': '.dmg',
};

function OsCard({
  os,
  variants,
  mine,
  n,
}: {
  os: Os;
  variants: DownloadVariant[];
  mine: boolean;
  n: number;
}) {
  const [main, ...rest] = variants;
  if (!main) {
    return (
      <div
        role="group"
        aria-label={`${OS_NAME[os]} build not published yet`}
        className="flex h-full w-full flex-col gap-12 rounded-[14px] border border-dashed border-rule bg-paper-2/30 p-6 sm:p-7"
      >
        <span className="label">Part {String(n).padStart(2, '0')}</span>
        <div>
          <p className="t-h3 text-ink-2">{OS_NAME[os]}</p>
          <p className="mono mt-3 text-[11.5px] tracking-[0.02em] text-ink-3">Not published yet</p>
        </div>
      </div>
    );
  }
  return (
    <div
      className={cn(
        'flex h-full w-full flex-col gap-12 rounded-[14px] border p-6 sm:p-7',
        mine ? 'border-ink bg-paper-2 shadow-[0_30px_60px_-30px_rgba(22,21,15,0.3)]' : 'border-rule bg-paper-2/60',
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <span className="label">Part {String(n).padStart(2, '0')}</span>
        {mine && <span className="label rounded-full bg-ink px-2.5 py-0.5 text-[10px] text-paper">Your system</span>}
      </div>
      <div>
        <p className="t-h3">{OS_NAME[os]}</p>
        <p className="mono mt-3 text-[11.5px] tracking-[0.02em] text-ink-2">
          {OS_ARCH[os]} <span className="text-ink-3">·</span> v{main.version}
        </p>
        <a
          href={main.url}
          aria-label={`Download Plasma ${main.version} for ${main.label}${main.sizeLabel ? `, ${main.sizeLabel}` : ''}`}
          className={cn(
            'group mt-7 inline-flex h-11 items-center gap-2 rounded-full px-5 text-[15px] font-bold transition-colors duration-200',
            mine
              ? 'bg-signal text-signal-ink hover:bg-[#b83a22]'
              : 'border border-ink/25 text-ink hover:border-ink hover:bg-ink hover:text-paper',
          )}
        >
          {SHORT[main.key] ?? 'Download'}
          {main.sizeLabel && <span className="font-medium opacity-75">{main.sizeLabel}</span>}
          <ArrowDown className="h-4 w-4 transition-transform duration-300 group-hover:translate-y-0.5" strokeWidth={2.4} />
        </a>
        {rest.length > 0 && (
          <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
            {rest.map((v) => (
              <li key={v.key}>
                <a
                  href={v.url}
                  aria-label={`Download Plasma ${v.version}, ${v.label}${v.sizeLabel ? `, ${v.sizeLabel}` : ''}`}
                  className="text-[14px] font-medium text-ink-2 underline decoration-rule decoration-2 underline-offset-[5px] transition-colors hover:text-ink hover:decoration-ink"
                >
                  {SHORT[v.key] ?? v.label}
                  {v.sizeLabel && <span className="text-ink-3"> · {v.sizeLabel}</span>}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function Download() {
  const { releases, visitor } = usePlatform();
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

  // The visitor's own system first, then the rest in a fixed order.
  const order = (['mac', 'win', 'linux'] as const)
    .slice()
    .sort((a, b) => (a === visitor ? -1 : b === visitor ? 1 : 0));

  return (
    <section id="download" aria-labelledby="download-title" className="border-t border-rule bg-paper-2/50 py-24 md:py-32">
      <div className="wrap">
        <SectionHead plate="Plate 06" name="Download" />

        <Reveal className="mt-14">
          <h2 id="download-title" className="display t-h2">
            Install Plasma.
          </h2>
        </Reveal>

        {visitor === 'mobile' && (
          <p className="prose-p mt-10" role="note">
            Plasma is a desktop app. Open this page on a Mac, Windows or Linux computer.
          </p>
        )}

        <ul className="mt-14 grid gap-5 md:grid-cols-3">
          {order.map((os, i) => (
            <Reveal as="li" key={os} delay={i * 70} className="flex">
              <OsCard os={os} variants={releases[os]?.variants ?? []} mine={os === visitor} n={i + 1} />
            </Reveal>
          ))}
        </ul>

        <Reveal className="mt-14 grid gap-6 border-t border-ink pt-6 lg:grid-cols-12" delay={80}>
          <div className="lg:col-span-5">
            <p className="label text-ink">macOS first start</p>
            <p className="prose-p mt-3">
              The builds do not have an Apple signature yet. If macOS stops Plasma, open System Settings, Privacy
              &amp; Security, and click Open Anyway. You can also do this command:
            </p>
          </div>
          <div className="min-w-0 lg:col-span-7 lg:self-end">
            <div className="flex items-center justify-between gap-4 rounded-[14px] border border-rule bg-paper-2 py-2 pl-5 pr-2">
              <code className="mono min-w-0 overflow-x-auto whitespace-nowrap py-2 text-[13px] text-ink">{CMD}</code>
              <button
                type="button"
                onClick={copy}
                className="mono inline-flex h-10 shrink-0 items-center gap-2 rounded-full border border-ink/20 px-4 text-[11.5px] font-medium text-ink transition-colors duration-200 hover:border-ink hover:bg-ink hover:text-paper"
              >
                {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <span className="sr-only" aria-live="polite">
              {copied ? 'Command copied to clipboard' : ''}
            </span>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
