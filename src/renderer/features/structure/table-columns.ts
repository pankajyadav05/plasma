import { ipc } from '@/lib/ipc';
import { qualifiedName } from '@shared/pg-ddl';

export interface TableColumn {
  name: string;
  type: string;
  /** GENERATED ALWAYS columns and identity-always columns cannot be inserted into. */
  generated: boolean;
}

/**
 * Columns of one relation straight from the catalog. The sidebar schema
 * only loads columns lazily per schema, so dialogs that need another
 * table's columns (FK targets, import targets) ask directly.
 */
export async function fetchTableColumns(schema: string, table: string): Promise<TableColumn[]> {
  const res = await ipc.query.run(
    `SELECT a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod), (a.attgenerated <> '' OR a.attidentity = 'a')
       FROM pg_attribute a
      WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [qualifiedName(schema, table)],
    { internal: true },
  );
  return res.rows.map((r) => ({
    name: String(r[0]),
    type: String(r[1]),
    generated: r[2] === true || r[2] === 't',
  }));
}
