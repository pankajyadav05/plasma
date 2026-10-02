import { cn } from '@/lib/cn';

/** The wordmark: "plasma" in heavy expanded Archivo with a signal-coloured full stop. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn('display inline-block leading-none', className)}
      style={{ fontVariationSettings: "'wdth' 120" }}
    >
      plasma<span className="text-signal">.</span>
    </span>
  );
}
