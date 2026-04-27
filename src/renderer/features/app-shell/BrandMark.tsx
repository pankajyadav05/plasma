import markSvg from '@logo/plasma-mark.svg?raw';
import { cn } from '@/lib/cn';

/**
 * Plasma monogram (italic serif P + oxblood stroke). Inlined via Vite
 * `?raw` so Newsreader (from the host document) and `currentColor` +
 * `var(--primary)` all work, and so the asset still resolves after
 * packaging (a plain `<img src="/plasma-mark.svg">` breaks under
 * `file://` origins because the absolute path escapes the app root).
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-block leading-none [&>svg]:h-full [&>svg]:w-full [&>svg]:block',
        className,
      )}
      aria-hidden
      // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted local asset
      dangerouslySetInnerHTML={{ __html: markSvg }}
    />
  );
}
