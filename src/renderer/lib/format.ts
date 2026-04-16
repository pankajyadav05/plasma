/**
 * Format a duration in milliseconds for display next to query results.
 *
 *   <  1000 ms  → "842 ms"
 *   1s ≤ t < 60s → "2.4s" (one decimal) or "2s 384 ms" on demand
 *   ≥ 60s       → "1m 12s"
 *
 * The current form mirrors the user's request: ms below a second, s+ms
 * up to a minute, m+s+ms beyond. Commas in the ms component come from
 * the locale formatter to keep large counts readable.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "–";
  if (ms < 1_000) {
    return `${Math.round(ms).toLocaleString()} ms`;
  }
  if (ms < 60_000) {
    const seconds = Math.floor(ms / 1_000);
    const remMs = Math.round(ms - seconds * 1_000);
    if (remMs === 0) return `${seconds}s`;
    return `${seconds}s ${remMs} ms`;
  }
  const minutes = Math.floor(ms / 60_000);
  const remAfterMin = ms - minutes * 60_000;
  const seconds = Math.floor(remAfterMin / 1_000);
  const remMs = Math.round(remAfterMin - seconds * 1_000);
  const parts = [`${minutes}m`];
  if (seconds > 0) parts.push(`${seconds}s`);
  if (remMs > 0) parts.push(`${remMs} ms`);
  return parts.join(" ");
}
