import wordmarkSvg from '@logo/plasma-mono-accent.svg?raw';
import { cn } from '@/lib/cn';

/**
 * Plasma brand wordmark — imports the SVG file as raw text via Vite's
 * `?raw` loader, then injects it inline so:
 *   - Newsreader (loaded by the host document) is visible to SVG text,
 *   - `currentColor` picks up the parent's color,
 *   - `var(--primary)` tracks theme/palette changes.
 *
 * A plain `<img src>` renders SVGs in an isolated doc and would miss
 * all three. Keep the SVG file as source of truth — this component just
 * embeds its contents into the React tree.
 */
export function BrandWordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-block leading-none [&>svg]:h-full [&>svg]:w-auto [&>svg]:block',
        className,
      )}
      aria-label="Plasma"
      role="img"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted local asset
      dangerouslySetInnerHTML={{ __html: wordmarkSvg }}
    />
  );
}
