import pg from 'pg';

/**
 * Result-value parsing for every Plasma Postgres client.
 *
 * pg's defaults turn `date` / `timestamp` into local-time JS Dates (so a
 * date shifts a day west of UTC and microseconds vanish), `interval` into
 * `{ hours: 1 }`, `bytea` into a Buffer that reaches the renderer as
 * `{"0":222,…}`, `numeric[]` into lossy floats and `point` into objects.
 * None of that survives display, editing or export.
 *
 * Plasma instead keeps the Postgres text form for everything except the
 * handful of types where a JS value is exact and useful:
 *
 *   bool, int2, int4, oid       → boolean / number (exact)
 *   float4, float8              → number (PG sends shortest round-trip text)
 *   json, jsonb                 → parsed value (JSON viewer, pretty export)
 *
 * Everything else — date, time, timetz, timestamp, timestamptz, interval,
 * bytea (`\x…` hex), numeric, int8, money, arrays, ranges, geometric
 * types — arrives exactly as the server printed it. Nothing is converted
 * to a JS Date.
 */
const PARSED_OIDS = new Set<number>([
  16, // bool
  21, // int2
  23, // int4
  26, // oid
  700, // float4
  701, // float8
  114, // json
  3802, // jsonb
]);

const identity = (value: string): string => value;

type TypeParser = (value: string) => unknown;

function getTypeParser(oid: number, format?: 'text' | 'binary'): TypeParser {
  if (format === 'binary') {
    return pg.types.getTypeParser(oid, 'binary') as TypeParser;
  }
  if (PARSED_OIDS.has(oid)) return pg.types.getTypeParser(oid, 'text') as TypeParser;
  return identity;
}

/**
 * `types` override for `new pg.Client({ types })`. Scoped per client so
 * nothing else in the process (tests, other libraries) is affected.
 */
export const plasmaPgTypes = { getTypeParser } as unknown as NonNullable<pg.ClientConfig['types']>;

/** Exposed for unit tests. */
export function parsePgText(oid: number, text: string): unknown {
  return getTypeParser(oid, 'text')(text);
}
