'use client';

import { ArrowDown } from 'lucide-react';
import { CopyLine } from '@/components/copy-line';
import { SectionHead } from '@/components/plate';
import { Reveal } from '@/components/reveal';
import { Sheet, SheetCell, SheetGrid } from '@/components/sheet';
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
}: {
  os: Os;
  variants: DownloadVariant[];
  mine: boolean;
}) {
  const [main, ...rest] = variants;
  if (!main) {
    return (
      <div
        role="group"
        aria-label={`${OS_NAME[os]} build not published yet`}
        className="flex h-full w-full flex-col gap-12 rounded-[14px] border border-dashed border-rule bg-paper-2/30 p-6 sm:p-7"
      >
        <span className="label">{OS_ARCH[os]}</span>
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
        <span className="label">{OS_ARCH[os]}</span>
        {mine && <span className="label rounded-full bg-ink px-2.5 py-0.5 text-[10px] text-paper">Your system</span>}
      </div>
      <div>
        <p className="t-h3">{OS_NAME[os]}</p>
        <p className="mono mt-3 text-[11.5px] tracking-[0.02em] text-ink-2">
          v{main.version}
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
  // The visitor's own system first, then the rest in a fixed order.
  const order = (['mac', 'win', 'linux'] as const)
    .slice()
    .sort((a, b) => (a === visitor ? -1 : b === visitor ? 1 : 0));

  return (
    <section id="download" aria-labelledby="download-title" className="border-t border-rule bg-paper-2/50 py-24 md:py-32">
      <div className="wrap">
        <SectionHead name="Download" />

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
              <OsCard os={os} variants={releases[os]?.variants ?? []} mine={os === visitor} />
            </Reveal>
          ))}
        </ul>

        <Reveal className="mt-14" delay={80}>
          <Sheet>
            <SheetGrid className="lg:grid-cols-[1.25fr_1fr_1fr]">
              <SheetCell kind="macOS first start" index={0}>
                <p className="prose-p mt-4 text-[15.5px]">
                  The builds do not have an Apple signature yet. If macOS stops Plasma, open System Settings, Privacy
                  &amp; Security, and click Open Anyway. Or run this command:
                </p>
                <CopyLine className="mt-4" text={CMD} stacked />
              </SheetCell>
              <SheetCell kind="Linux" index={1}>
                <p className="prose-p mt-4 text-[15.5px]">
                  Pick the AppImage or the .deb. The AppImage updates itself. The .deb installs an AppArmor profile
                  so the Chromium sandbox keeps working on Ubuntu 24.04 and later, and needs administrator rights to
                  update.
                </p>
              </SheetCell>
              <SheetCell kind="Updates" index={2}>
                <p className="prose-p mt-4 text-[15.5px]">
                  After this, Plasma updates itself: a button appears, you click restart, you are back where you were.
                  This holds for macOS in Applications, a per-user Windows install and the Linux AppImage.
                </p>
              </SheetCell>
            </SheetGrid>
          </Sheet>
        </Reveal>
      </div>
    </section>
  );
}
