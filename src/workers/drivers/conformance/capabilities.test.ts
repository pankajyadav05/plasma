import { describe, expect, it } from 'vitest';
import { CAPABILITY_DOCS, CAPABILITY_KEYS, type Capabilities, optOutReason } from './capabilities';
import { clickhouseFixture } from './fixtures/clickhouse';
import { duckdbFixture } from './fixtures/duckdb';
import { mysqlFixture } from './fixtures/mysql';
import { postgresFixture } from './fixtures/postgres';
import { sqliteFixture } from './fixtures/sqlite';
import { opensearchCaps } from './opensearch-suite';
import { redisCaps } from './redis-suite';

/**
 * The opt-out rule of the conformance suite: an engine skips a scenario only
 * through a capability flag that carries its reason. These checks keep that
 * honest: every engine states every flag, and an opt-out always says why.
 */
const sqlFixtures = [
  sqliteFixture(),
  duckdbFixture(),
  postgresFixture(),
  mysqlFixture('mysql'),
  mysqlFixture('mariadb'),
  clickhouseFixture(),
];

const engines: Array<[string, Capabilities]> = [
  ...sqlFixtures.map((fx): [string, Capabilities] => [fx.id, fx.caps]),
  ['redis', redisCaps],
  ['opensearch', opensearchCaps],
];

describe('capability flags', () => {
  it.each(engines)('%s states every flag, and every opt-out gives a reason', (_name, caps) => {
    expect(Object.keys(caps).sort()).toEqual([...CAPABILITY_KEYS].sort());
    for (const key of CAPABILITY_KEYS) {
      const reason = optOutReason(caps[key]);
      if (reason !== null) {
        expect(reason.length, `${key} needs a real reason`).toBeGreaterThanOrEqual(20);
      }
    }
  });

  it('documents every flag', () => {
    for (const key of CAPABILITY_KEYS) expect(CAPABILITY_DOCS[key].length).toBeGreaterThan(10);
  });

  it('keeps the core scenarios mandatory for the SQL engines', () => {
    // Never opted out: every SQL engine reconnects, introspects keys, caps results, cancels,
    // honours read-only and has a read-only agent path. Features an engine genuinely lacks
    // (transactions, row edits, foreign keys...) have their own flag.
    for (const fx of sqlFixtures) {
      for (const key of [
        'reconnect',
        'primaryKeys',
        'resultCap',
        'cancel',
        'readOnlyConnection',
        'aiQuery',
      ] as const) {
        expect(optOutReason(fx.caps[key]), `${fx.id} must not opt out of ${key}`).toBeNull();
      }
    }
  });

  it('every type case names a real flag', () => {
    for (const fx of sqlFixtures) {
      for (const tc of fx.typeCases) {
        if (tc.needs) expect(CAPABILITY_KEYS).toContain(tc.needs);
      }
    }
  });
});
