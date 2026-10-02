import type { IntrospectOpts, SchemaInfo } from '@shared/protocol';

/**
 * Catalog introspection for the Postgres sidebar, autocomplete and grid.
 *
 * Split in two scopes so big databases don't pay for every column of
 * every table on each refresh (F16 / PC4):
 *   - objects: schemas, relations, routines, sequences, types, extensions
 *   - columns: columns + foreign keys, optionally limited to some schemas
 * The renderer loads objects for everything and columns per schema on
 * demand, merging the results.
 */

/** The slice of `pg.Client` this module needs — easy to fake in tests. */
export interface IntrospectClient {
  query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

/** System schemas hidden from every listing. */
const SYSTEM_SCHEMA_FILTER = `n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
         AND n.nspname NOT LIKE 'pg_temp_%'
         AND n.nspname NOT LIKE 'pg_toast_temp_%'`;

/** Objects owned by an extension (postgis, pg_trgm…) would swamp the list. */
const NOT_EXTENSION_MEMBER = (classId: string, oidExpr: string) =>
  `NOT EXISTS (SELECT 1 FROM pg_depend d
                WHERE d.classid = '${classId}'::regclass AND d.objid = ${oidExpr} AND d.deptype = 'e')`;

const KIND_MAP = { r: 'table', v: 'view', m: 'matview', f: 'foreign', p: 'partitioned' } as const;

const TYPE_KIND_MAP = { e: 'enum', c: 'composite', d: 'domain', r: 'range' } as const;

export async function introspectPostgres(
  client: IntrospectClient,
  opts: IntrospectOpts = {},
): Promise<SchemaInfo> {
  const wantObjects = opts.objects !== false;
  const wantColumns = opts.columns !== false;
  const out: SchemaInfo = {
    schemas: [],
    tables: [],
    columns: [],
    foreignKeys: [],
    routines: [],
    sequences: [],
    types: [],
    extensions: [],
  };

  // IMPORTANT: pg.Client serializes queries internally but warns (and in
  // pg@9 will error) on concurrent .query() calls. Run sequentially.
  if (wantObjects) {
    const version = await client.query<{ v: string }>(
      `SELECT current_setting('server_version_num') AS v`,
    );
    const versionNum = Number(version.rows[0]?.v ?? 0);

    const schemas = await client.query<{ schema_name: string }>(
      `SELECT n.nspname AS schema_name
       FROM pg_namespace n
       WHERE ${SYSTEM_SCHEMA_FILTER}
       ORDER BY n.nspname`,
    );
    out.schemas = schemas.rows.map((r) => ({ name: r.schema_name }));

    // Partition children carry their partitioned parent so the sidebar
    // can nest them. pg_inherits + relkind 'p' works on every version
    // (pre-10 simply never matches).
    const tables = await client.query<{
      schema: string;
      name: string;
      kind: keyof typeof KIND_MAP;
      row_count: string | null;
      parent_schema: string | null;
      parent_name: string | null;
    }>(
      `SELECT n.nspname AS schema,
              c.relname  AS name,
              c.relkind  AS kind,
              NULLIF(c.reltuples, -1)::bigint::text AS row_count,
              par.parent_schema,
              par.parent_name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN LATERAL (
         SELECT pn.nspname AS parent_schema, pc.relname AS parent_name
         FROM pg_inherits i
         JOIN pg_class pc ON pc.oid = i.inhparent AND pc.relkind = 'p'
         JOIN pg_namespace pn ON pn.oid = pc.relnamespace
         WHERE i.inhrelid = c.oid
         LIMIT 1
       ) par ON true
       WHERE c.relkind IN ('r', 'v', 'm', 'f', 'p')
         AND ${SYSTEM_SCHEMA_FILTER}
       ORDER BY n.nspname, c.relname`,
    );
    out.tables = tables.rows.map((r) => ({
      schema: r.schema,
      name: r.name,
      kind: KIND_MAP[r.kind],
      rowCountEstimate: r.row_count !== null ? Number(r.row_count) : null,
      partitionOf:
        r.parent_schema !== null && r.parent_name !== null
          ? { schema: r.parent_schema, name: r.parent_name }
          : null,
    }));

    // prokind arrived in PG 11; older servers flag aggregates/windows instead.
    const kindExpr =
      versionNum >= 110000
        ? 'p.prokind'
        : `CASE WHEN p.proisagg THEN 'a' WHEN p.proiswindow THEN 'w' ELSE 'f' END`;
    const routines = await client.query<{
      schema: string;
      name: string;
      kind: string;
      args: string;
      returns: string | null;
      oid: number;
    }>(
      `SELECT * FROM (
         SELECT n.nspname AS schema,
                p.proname AS name,
                ${kindExpr}::text AS kind,
                pg_get_function_identity_arguments(p.oid) AS args,
                CASE WHEN ${kindExpr}::text = 'p' THEN NULL
                     ELSE pg_get_function_result(p.oid) END AS returns,
                p.oid::int8 AS oid
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE ${SYSTEM_SCHEMA_FILTER}
           AND ${NOT_EXTENSION_MEMBER('pg_proc', 'p.oid')}
       ) r
       WHERE r.kind IN ('f', 'p', 'w')
       ORDER BY r.schema, r.name, r.args`,
    );
    out.routines = routines.rows.map((r) => ({
      schema: r.schema,
      name: r.name,
      kind: r.kind === 'p' ? 'procedure' : 'function',
      args: r.args ?? '',
      returns: r.returns,
      oid: Number(r.oid),
    }));

    const sequences = await client.query<{ schema: string; name: string }>(
      `SELECT n.nspname AS schema, c.relname AS name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind = 'S'
         AND ${SYSTEM_SCHEMA_FILTER}
         AND ${NOT_EXTENSION_MEMBER('pg_class', 'c.oid')}
       ORDER BY n.nspname, c.relname`,
    );
    out.sequences = sequences.rows.map((r) => ({ schema: r.schema, name: r.name }));

    // Standalone composite types only (every table has a row type too).
    const types = await client.query<{
      schema: string;
      name: string;
      kind: keyof typeof TYPE_KIND_MAP;
      enum_values: string[] | null;
    }>(
      `SELECT n.nspname AS schema,
              t.typname AS name,
              t.typtype AS kind,
              -- json, not text[]: Plasma's type parsers keep arrays as their
              -- text form ('{a,b}'), json arrives as a real array.
              CASE WHEN t.typtype = 'e' THEN
                to_json(ARRAY(SELECT e.enumlabel::text FROM pg_enum e
                              WHERE e.enumtypid = t.oid ORDER BY e.enumsortorder))
              END AS enum_values
       FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
       LEFT JOIN pg_class c ON c.oid = t.typrelid
       WHERE t.typtype IN ('e', 'c', 'd', 'r')
         AND (t.typtype <> 'c' OR c.relkind = 'c')
         AND ${SYSTEM_SCHEMA_FILTER}
         AND ${NOT_EXTENSION_MEMBER('pg_type', 't.oid')}
       ORDER BY n.nspname, t.typname`,
    );
    out.types = types.rows.map((r) => ({
      schema: r.schema,
      name: r.name,
      kind: TYPE_KIND_MAP[r.kind],
      ...(r.kind === 'e' ? { values: r.enum_values ?? [] } : {}),
    }));

    const extensions = await client.query<{ name: string; schema: string; version: string }>(
      `SELECT e.extname AS name, n.nspname AS schema, e.extversion AS version
       FROM pg_extension e
       JOIN pg_namespace n ON n.oid = e.extnamespace
       ORDER BY e.extname`,
    );
    out.extensions = extensions.rows.map((r) => ({
      name: r.name,
      schema: r.schema,
      version: r.version,
    }));
  }

  if (wantColumns) {
    const limit = opts.columnSchemas;
    // An explicit empty list means "no schemas" — skip the round-trips.
    if (limit && limit.length === 0) return out;
    const params = limit ? [limit] : [];
    const schemaFilter = limit ? 'AND n.nspname = ANY($1::text[])' : '';

    const columns = await client.query<{
      schema: string;
      table: string;
      name: string;
      data_type: string;
      ordinal: number;
      is_pk: boolean;
      is_nullable: boolean;
      has_default: boolean;
    }>(
      `SELECT n.nspname AS schema,
              c.relname  AS "table",
              a.attname  AS name,
              format_type(a.atttypid, a.atttypmod) AS data_type,
              a.attnum   AS ordinal,
              COALESCE(pk.is_pk, false) AS is_pk,
              NOT a.attnotnull AS is_nullable,
              a.atthasdef AS has_default
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN LATERAL (
         SELECT true AS is_pk
         FROM pg_constraint con
         WHERE con.conrelid = c.oid
           AND con.contype = 'p'
           AND a.attnum = ANY (con.conkey)
         LIMIT 1
       ) pk ON true
       WHERE a.attnum > 0
         AND NOT a.attisdropped
         AND c.relkind IN ('r', 'v', 'm', 'f', 'p')
         AND ${SYSTEM_SCHEMA_FILTER}
         ${schemaFilter}
       ORDER BY n.nspname, c.relname, a.attnum`,
      params,
    );
    out.columns = columns.rows.map((r) => ({
      schema: r.schema,
      table: r.table,
      name: r.name,
      dataType: r.data_type,
      ordinal: r.ordinal,
      isPrimaryKey: r.is_pk,
      isNullable: r.is_nullable,
      hasDefault: r.has_default,
    }));

    // Foreign keys — one row per FK column. `unnest ... WITH ORDINALITY`
    // pairs each conkey index with its confkey index so a composite FK
    // yields one row per column pair.
    const foreignKeys = await client.query<{
      schema: string;
      table: string;
      column: string;
      ref_schema: string;
      ref_table: string;
      ref_column: string;
    }>(
      `SELECT n.nspname   AS schema,
              c.relname   AS "table",
              a.attname   AS column,
              fn.nspname  AS ref_schema,
              fc.relname  AS ref_table,
              fa.attname  AS ref_column
       FROM pg_constraint con
       JOIN pg_class     c  ON c.oid  = con.conrelid
       JOIN pg_namespace n  ON n.oid  = c.relnamespace
       JOIN pg_class     fc ON fc.oid = con.confrelid
       JOIN pg_namespace fn ON fn.oid = fc.relnamespace
       JOIN LATERAL unnest(con.conkey)  WITH ORDINALITY AS k(attnum, ord) ON true
       JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS fk(attnum, ord) ON fk.ord = k.ord
       JOIN pg_attribute a  ON a.attrelid  = c.oid  AND a.attnum  = k.attnum
       JOIN pg_attribute fa ON fa.attrelid = fc.oid AND fa.attnum = fk.attnum
       WHERE con.contype = 'f'
         AND ${SYSTEM_SCHEMA_FILTER}
         ${schemaFilter}
       ORDER BY n.nspname, c.relname, a.attnum`,
      params,
    );
    out.foreignKeys = foreignKeys.rows.map((r) => ({
      schema: r.schema,
      table: r.table,
      column: r.column,
      refSchema: r.ref_schema,
      refTable: r.ref_table,
      refColumn: r.ref_column,
    }));
  }

  return out;
}
