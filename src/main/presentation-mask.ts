import { type MaskRules, maskResultRows } from '@shared/masking';
import { getSetting } from './settings';

/**
 * Presentation mode also covers what leaves the app for the AI provider:
 * row-data tool results are masked with the same detectors the grid uses.
 */
export function maskRowsForAi(
  connectionId: string | null,
  columns: ReadonlyArray<{ name: string; dataTypeName?: string | null }>,
  rows: unknown[][],
): unknown[][] {
  if (!getSetting<boolean>('presentationMode', false)) return rows;
  const style = getSetting<'initial' | 'last4' | 'full'>('maskStyle', 'initial');
  const all = getSetting<Record<string, MaskRules>>('maskRules', {});
  const rules = connectionId ? all[connectionId] : undefined;
  return maskResultRows(columns, rows, { style, rules });
}
