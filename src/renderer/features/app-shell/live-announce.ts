import { cleanIpcError } from '@/lib/errors';

/** Spoken summary of a finished query (AA7). */
export function describeQueryOutcome(
  result: { rowCount: number; durationMs: number; command?: string; truncated?: boolean } | null,
  error: string | null,
  phase?: string,
  lifeMessage?: string,
): string {
  if (phase === 'cancelled') return 'Query cancelled';
  if (phase === 'unknown') {
    return 'Outcome unknown: the connection dropped after the statement was sent. Check the data.';
  }
  if (phase === 'disconnected') return `Connection dropped: ${lifeMessage ?? 'query not finished'}`;
  if (error) return `Query failed: ${cleanIpcError(error)}`;
  if (!result) return 'Query finished';
  const ms = Math.round(result.durationMs);
  const rows = `${result.rowCount.toLocaleString()} row${result.rowCount === 1 ? '' : 's'}`;
  const cmd = result.command && result.command !== 'SELECT' ? `${result.command} · ` : '';
  return `${cmd}${rows}${result.truncated ? ' (truncated)' : ''} · ${ms} ms`;
}
