'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/cn';

/** A line of shell or config text with a Copy button. The text stays selectable if the clipboard is blocked. */
export function CopyLine({
  text,
  label,
  className,
  stacked = false,
}: {
  text: string;
  /** Button under the text instead of beside it, for narrow cells. */
  stacked?: boolean;
  /** Mono label above the line, e.g. "Claude Code". */
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable: the text stays selectable */
    }
  };

  return (
    <div className={className}>
      {label && <p className="label mb-2 text-ink">{label}</p>}
      <div className={cn('rounded-[14px] border border-rule bg-paper-2 py-2 pl-5 pr-2', stacked ? 'flex flex-col items-start gap-1' : 'flex items-start justify-between gap-3')}>
        <code className={cn('mono min-w-0 flex-1 py-2.5 text-[12.5px] leading-[1.6] text-ink [overflow-wrap:anywhere]')}>
          {text}
        </code>
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
        {copied ? 'Copied to clipboard' : ''}
      </span>
    </div>
  );
}
