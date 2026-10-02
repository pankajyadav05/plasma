'use client';

import { ArrowDown } from 'lucide-react';
import { usePlatform } from '@/lib/platform';

/** OS-detected primary download pill plus the small secondary links. */
export function HeroCta() {
  const { os, primary } = usePlatform();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-x-7 gap-y-4">
        <a
          href={primary.url}
          className="group inline-flex h-14 items-center gap-3 rounded-full bg-signal pl-7 pr-6 text-[17px] font-bold text-signal-ink shadow-[0_10px_24px_-10px_rgba(207,68,41,0.6)] transition-[transform,background-color,box-shadow] duration-300 hover:-translate-y-0.5 hover:bg-[#b83a22] hover:shadow-[0_16px_30px_-12px_rgba(207,68,41,0.7)] active:translate-y-0 active:scale-[0.98]"
        >
          Download for {os === 'mac' ? 'macOS' : 'Windows'}
          <ArrowDown className="h-[18px] w-[18px] transition-transform duration-300 group-hover:translate-y-0.5" strokeWidth={2.4} />
        </a>
        <a
          href="#download"
          className="text-[15px] font-medium text-ink-2 underline decoration-rule decoration-2 underline-offset-[6px] transition-colors hover:text-ink hover:decoration-ink"
        >
          Other platforms ↓
        </a>
      </div>
      <a
        href="https://github.com/pankajyadav05/plasma"
        className="w-fit text-[15px] font-medium text-ink underline decoration-ink/25 decoration-1 underline-offset-[6px] transition-colors hover:decoration-ink"
      >
        View source on GitHub ↗
      </a>
    </div>
  );
}
