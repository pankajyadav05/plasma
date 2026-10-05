import { cn } from '@/lib/cn';
import { ENGINE_LABEL } from '@/lib/engine-meta';
import type { ConnectionEngine } from '@shared/protocol';
import { type EnvTag, TAG_COLOR, TAG_LABEL } from './env-tags';

/**
 * A live copy of the top bar's status capsule, built from the form: the same
 * surface token, separators and environment chip. Prod fills it red.
 */
export function CapsulePreview({
  engine,
  tls,
  name,
  database,
  tag,
}: {
  engine: ConnectionEngine;
  /** TLS segment text; null hides it (file engines). */
  tls: string | null;
  name: string;
  database: string;
  tag: EnvTag | null;
}) {
  const prod = tag === 'prod';
  const segs = [ENGINE_LABEL[engine], tls, name.trim() || 'Untitled', database.trim() || null];
  const shown = segs.filter((s): s is string => Boolean(s));
  return (
    <div className="flex flex-col gap-1.5">
      <div
        data-testid="capsule-preview"
        role="img"
        aria-label={`Top bar preview: ${shown.join(', ')}${tag ? `, ${TAG_LABEL[tag]}` : ''}`}
        className={cn(
          'flex h-9 min-w-0 items-center overflow-hidden rounded-full px-4 font-mono text-[13px] font-semibold leading-none',
          'shadow-[inset_0_1px_0_rgb(255_255_255/0.08)]',
          prod ? 'text-white' : 'text-[var(--wb-text)]',
        )}
        style={{ backgroundColor: prod ? 'var(--status-prod)' : 'var(--wb-connected)' }}
      >
        <span className="flex min-w-0 items-center" aria-hidden>
          {shown.map((s, i) => (
            <span key={`${i}-${s}`} className="flex min-w-0 items-center">
              {i > 0 && <span className="shrink-0 whitespace-pre opacity-60">{' : '}</span>}
              <span className="min-w-0 truncate whitespace-nowrap">{s}</span>
            </span>
          ))}
          {tag && (
            <span
              className={cn(
                'ml-2.5 shrink-0 rounded-[4px] px-1.5 py-[3px] font-sans text-[11px] font-semibold text-white',
                prod && 'bg-black/25',
              )}
              style={prod ? undefined : { backgroundColor: TAG_COLOR[tag] }}
            >
              {TAG_LABEL[tag]}
            </span>
          )}
        </span>
      </div>
      <p className="text-[12px] text-[var(--wb-text-3)]">
        This is how the top bar will show this connection.
      </p>
    </div>
  );
}
