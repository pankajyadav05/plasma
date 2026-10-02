import { cn } from '@/lib/cn';
import type { ReactNode } from 'react';
import { type Block, type Inline, parseMarkdown } from './markdown-lite';

/**
 * Renders the notebook's Markdown subset as React elements. There is no
 * `dangerouslySetInnerHTML` anywhere: everything the parser did not
 * recognise is plain text (see markdown-lite.ts).
 */
function renderInline(nodes: Inline[], keyPrefix = 'i'): ReactNode[] {
  return nodes.map((n, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (n.t) {
      case 'text':
        return n.v;
      case 'code':
        return (
          <code
            key={key}
            className="rounded-[4px] bg-[var(--wb-control)] px-1 py-0.5 font-mono text-[0.92em]"
          >
            {n.v}
          </code>
        );
      case 'strong':
        return <strong key={key}>{renderInline(n.c, key)}</strong>;
      case 'em':
        return <em key={key}>{renderInline(n.c, key)}</em>;
      case 'link':
        return (
          <a
            key={key}
            href={n.href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[var(--wb-accent)] underline underline-offset-2"
          >
            {renderInline(n.c, key)}
          </a>
        );
    }
  });
}

const HEADING_CLASS: Record<number, string> = {
  1: 'text-[20px] font-semibold',
  2: 'text-[17px] font-semibold',
  3: 'text-[15px] font-semibold',
  4: 'text-[13px] font-semibold',
  5: 'text-[13px] font-medium',
  6: 'text-[12px] font-medium',
};

function renderBlock(b: Block, i: number): ReactNode {
  switch (b.t) {
    case 'heading': {
      const Tag = `h${b.level}` as 'h1';
      return (
        <Tag key={i} className={cn('mt-2 mb-1 text-[var(--wb-text)]', HEADING_CLASS[b.level])}>
          {renderInline(b.c)}
        </Tag>
      );
    }
    case 'p':
      return (
        <p key={i} className="my-1.5">
          {renderInline(b.c)}
        </p>
      );
    case 'code':
      return (
        <pre
          key={i}
          className="my-2 overflow-x-auto rounded-[6px] bg-[var(--wb-control)] p-2 font-mono text-[12px]"
        >
          <code>{b.v}</code>
        </pre>
      );
    case 'quote':
      return (
        <blockquote
          key={i}
          className="my-2 border-l-2 border-[var(--wb-separator)] pl-3 text-[var(--wb-text-2)]"
        >
          {renderInline(b.c)}
        </blockquote>
      );
    case 'ul':
      return (
        <ul key={i} className="my-1.5 list-disc pl-5">
          {b.items.map((it, j) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static parsed list
            <li key={j}>{renderInline(it)}</li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol key={i} className="my-1.5 list-decimal pl-5">
          {b.items.map((it, j) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static parsed list
            <li key={j}>{renderInline(it)}</li>
          ))}
        </ol>
      );
    case 'hr':
      return <hr key={i} className="my-3 h-px border-0 bg-[var(--wb-separator)]" />;
  }
}

export function MarkdownView({ source, className }: { source: string; className?: string }) {
  const blocks = parseMarkdown(source);
  if (blocks.length === 0) {
    return <div className="px-3 py-2 text-[13px] text-[var(--wb-text-3)]">Empty note</div>;
  }
  return (
    <div className={cn('px-3 py-2 text-[13px] leading-relaxed text-[var(--wb-text)]', className)}>
      {blocks.map(renderBlock)}
    </div>
  );
}
