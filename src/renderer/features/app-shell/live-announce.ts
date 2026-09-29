/** Spoken summary of a finished query (AA7). */
export function describeQueryOutcome(
  result: { rowCount: number; durationMs: number; command?: string; truncated?: boolean } | null,
  error: string | null,
): string {
  if (error) return `Query failed: ${error}`;
  if (!result) return 'Query finished';
  const ms = Math.round(result.durationMs);
  const rows = `${result.rowCount.toLocaleString()} row${result.rowCount === 1 ? '' : 's'}`;
  const cmd = result.command && result.command !== 'SELECT' ? `${result.command} · ` : '';
  return `${cmd}${rows}${result.truncated ? ' (truncated)' : ''} · ${ms} ms`;
}
