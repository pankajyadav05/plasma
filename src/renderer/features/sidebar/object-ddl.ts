/**
 * Catalog reads behind "Copy script as CREATE" and "Open definition" in
 * the sidebar. Every query is internal (kept out of history) and casts
 * values to text so the result shape doesn't depend on type parsers.
 */
import { ipc } from '@/lib/ipc';
import { buildDefinitionQuerySql } from '@/lib/table-query';
import type { SchemaInfo } from '@shared/protocol';
import {
  type DefinitionRow,
  type RelationKind,
  buildCompositeDdl,
  buildCreateViewScript,
  buildDomainDdl,
  buildEnumDdl,
  buildExtensionDdl,
  buildRangeDdl,
  buildSequenceDdl,
  composeCreateTable,
  quotedQualified,
} from './object-scripts';

type Routine = SchemaInfo['routines'][number];
type TypeInfo = SchemaInfo['types'][number];
type Extension = SchemaInfo['extensions'][number];

async function run(sql: string, params: unknown[]): Promise<unknown[][]> {
  const res = await ipc.query.run(sql, params, { internal: true });
  return res.rows as unknown[][];
}

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** CREATE script for a table-like relation or a (materialized) view. */
export async function loadRelationCreateScript(
  schema: string,
  name: string,
  kind: RelationKind,
): Promise<string> {
  if (kind === 'view' || kind === 'matview') {
    const rows = await run('SELECT pg_get_viewdef($1::regclass, true)::text', [
      quotedQualified(schema, name),
    ]);
    return buildCreateViewScript(kind, schema, name, text(rows[0]?.[0]));
  }
  const { sql, params } = buildDefinitionQuerySql(schema, name);
  const rows = await run(sql, params);
  const defs: DefinitionRow[] = rows.map((r) => ({
    kind: text(r[0]) as DefinitionRow['kind'],
    c1: text(r[2]),
    c2: text(r[3]),
    c3: text(r[4]),
    c4: text(r[5]),
  }));
  return composeCreateTable(schema, name, defs);
}

export async function loadRoutineDefinition(routine: Routine): Promise<string> {
  const rows = await run('SELECT pg_get_functiondef($1::oid)::text', [routine.oid]);
  const def = text(rows[0]?.[0]).trim();
  return def.endsWith(';') ? def : `${def};`;
}

export async function loadSequenceDdl(schema: string, name: string): Promise<string> {
  const rows = await run(
    `SELECT data_type::text, start_value::text, min_value::text, max_value::text,
            increment_by::text, cycle::text, cache_size::text
     FROM pg_sequences WHERE schemaname = $1 AND sequencename = $2`,
    [schema, name],
  );
  const r = rows[0];
  if (!r) throw new Error(`sequence ${schema}.${name} not found`);
  return buildSequenceDdl(schema, name, {
    dataType: text(r[0]),
    start: text(r[1]),
    min: text(r[2]),
    max: text(r[3]),
    increment: text(r[4]),
    cycle: text(r[5]) === 'true',
    cache: text(r[6]),
  });
}

export async function loadTypeDdl(t: TypeInfo): Promise<string> {
  switch (t.kind) {
    case 'enum':
      return buildEnumDdl(t.schema, t.name, t.values ?? []);
    case 'composite': {
      const rows = await run(
        `SELECT a.attname::text, format_type(a.atttypid, a.atttypmod)::text
         FROM pg_type ty
         JOIN pg_namespace n ON n.oid = ty.typnamespace
         JOIN pg_attribute a ON a.attrelid = ty.typrelid
         WHERE n.nspname = $1 AND ty.typname = $2 AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY a.attnum`,
        [t.schema, t.name],
      );
      return buildCompositeDdl(
        t.schema,
        t.name,
        rows.map((r) => ({ name: text(r[0]), type: text(r[1]) })),
      );
    }
    case 'domain': {
      const rows = await run(
        `SELECT format_type(ty.typbasetype, ty.typtypmod)::text,
                ty.typnotnull::text,
                ty.typdefault::text,
                (SELECT string_agg('CONSTRAINT ' || quote_ident(c.conname) || ' ' || pg_get_constraintdef(c.oid), E'\\n' ORDER BY c.conname)
                 FROM pg_constraint c WHERE c.contypid = ty.oid)::text
         FROM pg_type ty
         JOIN pg_namespace n ON n.oid = ty.typnamespace
         WHERE n.nspname = $1 AND ty.typname = $2`,
        [t.schema, t.name],
      );
      const r = rows[0];
      if (!r) throw new Error(`domain ${t.schema}.${t.name} not found`);
      const constraints = text(r[3]) ? text(r[3]).split('\n') : [];
      return buildDomainDdl(t.schema, t.name, {
        baseType: text(r[0]),
        notNull: text(r[1]) === 'true',
        defaultExpr: r[2] === null || r[2] === undefined ? null : text(r[2]),
        constraints,
      });
    }
    case 'range': {
      const rows = await run(
        `SELECT format_type(r.rngsubtype, NULL)::text
         FROM pg_range r
         JOIN pg_type ty ON ty.oid = r.rngtypid
         JOIN pg_namespace n ON n.oid = ty.typnamespace
         WHERE n.nspname = $1 AND ty.typname = $2`,
        [t.schema, t.name],
      );
      return buildRangeDdl(t.schema, t.name, text(rows[0]?.[0]));
    }
  }
}

export function extensionDdl(e: Extension): string {
  return buildExtensionDdl(e.name, e.schema, e.version);
}
