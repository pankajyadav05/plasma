/**
 * Foreign-key navigation helpers. The pure logic lives in `@shared/fk-nav` (so
 * the live Postgres test can use it from the node project); this re-exports it
 * and binds the renderer's value-to-text conversion.
 */
import type { IncomingCountRequest } from '@shared/fk-nav';
import { incomingRequestsForRow as incomingRequests } from '@shared/fk-nav';
import type { FkGroup } from '@shared/fk-nav';
import { cellToText } from './cell-edit';

export * from '@shared/fk-nav';

/** Count requests for a row, rendering values with the grid's `cellToText`. */
export function incomingRequestsForRow(
  groups: readonly FkGroup[],
  columns: ReadonlyArray<{ name: string; dataTypeName: string }>,
  row: readonly unknown[],
): IncomingCountRequest[] {
  return incomingRequests(groups, columns, row, (v, t) => cellToText(v, t));
}
