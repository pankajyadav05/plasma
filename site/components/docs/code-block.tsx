'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

export function CodeBlock({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked: the text stays selectable */
    }
  };
  return (
    <figure className="my-6 overflow-hidden rounded-[12px] border border-rule bg-paper-2">
      <figcaption className="flex items-center justify-between gap-3 border-b border-rule px-4 py-2">
        <span className="label">{label ?? 'Code'}</span>
        <button
          type="button"
          onClick={copy}
          className="mono inline-flex h-8 items-center gap-2 rounded-full border border-ink/20 px-3 text-[11.5px] font-medium text-ink transition-colors hover:border-ink hover:bg-ink hover:text-paper"
        >
          {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </figcaption>
      <pre className="mono overflow-x-auto px-4 py-3.5 text-[13px] leading-[1.7] text-ink">
        <code>{code}</code>
      </pre>
      <span className="sr-only" aria-live="polite">
        {copied ? 'Copied to clipboard' : ''}
      </span>
    </figure>
  );
}
