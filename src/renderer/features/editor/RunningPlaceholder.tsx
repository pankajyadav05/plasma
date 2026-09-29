import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

/** "1.2s" under a minute, then "1m 05s". */
export function formatElapsed(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < 60_000) return `${(safe / 1000).toFixed(1)}s`;
  const m = Math.floor(safe / 60_000);
  const s = Math.floor((safe % 60_000) / 1000);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

/**
 * Results pane while a SQL run has produced nothing yet (VF20): the pane
 * keeps its place (no editor jump) and shows how long the query has run.
 */
export function RunningPlaceholder({ startedAt }: { startedAt: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, []);
  const elapsed = startedAt ? now - startedAt : 0;
  return (
    <div
      className="grid min-h-0 flex-1 place-items-center bg-[var(--wb-content)]"
      data-testid="query-running"
      aria-live="polite"
    >
      <div className="flex items-center gap-2 text-[13px] text-[var(--wb-text-2)]">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        <span>
          Running…{' '}
          <span className="font-mono tabular-nums text-[var(--wb-text)]">
            {formatElapsed(elapsed)}
          </span>
        </span>
      </div>
    </div>
  );
}
