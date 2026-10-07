import { type MaskRules, type MaskStyle, maskResultRows } from '@shared/masking';

/**
 * Masking for MCP results. Always on, whatever presentation mode says, with
 * the connection's own rules and the default detectors, unless the user turned
 * on "Send unmasked values to MCP clients" for that connection.
 */
export function maskForMcp(
  columns: ReadonlyArray<{ name: string; dataTypeName?: string | null }>,
  rows: unknown[][],
  opts: { unmasked: boolean; style: MaskStyle; rules?: MaskRules },
): unknown[][] {
  if (opts.unmasked) return rows;
  return maskResultRows(columns, rows, { style: opts.style, rules: opts.rules });
}
