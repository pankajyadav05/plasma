'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ArrowDown, ChevronDown } from 'lucide-react';
import { Magnetic } from '@/components/magnetic';
import { cn } from '@/lib/cn';
import { type DownloadVariant, usePlatform } from '@/lib/platform';

type Size = 'xs' | 'md' | 'lg';

const SIZE_CLASSES: Record<Size, string> = {
  xs: 'px-4 py-2 text-[10px] tracking-[0.28em] gap-2',
  md: 'px-7 py-4 text-[11px] tracking-[0.3em] gap-3',
  lg: 'px-8 py-5 text-[12px] tracking-[0.3em] gap-3',
};

const TRIGGER_CLASSES: Record<Size, string> = {
  xs: 'px-2 py-2',
  md: 'px-3 py-4',
  lg: 'px-4 py-5',
};

const ICON_CLASSES: Record<Size, string> = {
  xs: 'h-3 w-3',
  md: 'h-3.5 w-3.5',
  lg: 'h-4 w-4',
};

/**
 * Split-button download CTA. The wide left half is a direct anchor to
 * the visitor's primary artifact (mac·arm64 on macOS, win·x64 elsewhere
 * — see usePlatform); the narrow right half opens a Radix dropdown of
 * alternate platforms. SSR renders the Windows defaults so first paint
 * matches today's HTML.
 *
 * The button surface is intentionally label-only — version + size live
 * in the nav ribbon and the hover cursor (`data-cursor`), keeping the
 * CTA a single decisive verb.
 *
 * `alternates` toggles the dropdown half. Set it `false` for the nav
 * pill where there's no room for the chevron.
 */
export function DownloadCTA({
  size = 'md',
  alternates = false,
  className,
}: {
  size?: Size;
  alternates?: boolean;
  className?: string;
}) {
  const { primary, alternates: alts } = usePlatform();
  const sizeClass = SIZE_CLASSES[size];
  const iconClass = ICON_CLASSES[size];

  if (!alternates) {
    return (
      <Magnetic strength={0.18} className={className}>
        <a
          href={primary.url}
          data-cursor={primary.cursor}
          className={cn(
            'group inline-flex items-center bg-plasma text-bg font-mono uppercase hover:bg-volt transition-colors',
            sizeClass,
          )}
        >
          <ArrowDown className={iconClass} />
          Download
        </a>
      </Magnetic>
    );
  }

  return (
    <Magnetic strength={0.18} className={className}>
      <span
        className={cn(
          'inline-flex items-stretch font-mono uppercase',
          'divide-x divide-bg/20',
        )}
      >
        <a
          href={primary.url}
          data-cursor={primary.cursor}
          className={cn(
            'group inline-flex items-center bg-plasma text-bg hover:bg-volt transition-colors',
            sizeClass,
          )}
        >
          <ArrowDown className={iconClass} />
          Download
        </a>

        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            data-cursor="more platforms"
            aria-label="More download options"
            className={cn(
              'inline-flex items-center justify-center bg-plasma text-bg hover:bg-volt transition-colors data-[state=open]:bg-volt focus:outline-none',
              TRIGGER_CLASSES[size],
            )}
          >
            <ChevronDown
              className={cn(
                iconClass,
                'transition-transform data-[state=open]:rotate-180',
              )}
            />
          </DropdownMenu.Trigger>

          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={6}
              className={cn(
                'z-50 min-w-[260px] border border-line-strong bg-bg p-1 font-mono text-[11px] uppercase tracking-[0.22em] text-fg/85',
                'shadow-[0_8px_24px_rgba(0,0,0,0.4)]',
              )}
            >
              {alts.map((v) => (
                <AlternateItem key={v.key} variant={v} />
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </span>
    </Magnetic>
  );
}

function AlternateItem({ variant }: { variant: DownloadVariant }) {
  return (
    <DropdownMenu.Item
      asChild
      className="outline-none focus:bg-line/40 data-[highlighted]:bg-line/40 cursor-pointer"
    >
      <a
        href={variant.url}
        data-cursor={variant.cursor}
        className="flex items-center justify-between gap-6 px-3 py-2.5 hover:text-plasma transition-colors"
      >
        <span>{variant.label}</span>
        <span className="text-fg/45">{variant.sizeLabel}</span>
      </a>
    </DropdownMenu.Item>
  );
}
