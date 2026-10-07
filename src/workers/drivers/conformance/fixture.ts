import type { ConnectionConfig, QueryResult } from '@shared/protocol';
import type { SqlEngine } from '@shared/sql-dialect';
import type { SqlEngineDriver } from '../sql-engine';
import type { Capabilities, CapabilityKey } from './capabilities';
import type { FlakyProxy } from './tcp-proxy';

/** Extra options a scenario may pass when it opens its own session. */
export interface OpenOpts {
  readOnly?: boolean;
  /** Connect-time statement timeout (ms), the driver's second `connect` argument. */
  statementTimeoutMs?: number;
  /** Open through the connection-loss proxy instead of straight to the server. */
  viaProxy?: boolean;
  /** Connect with this password instead of the right one. */
  password?: string;
}

/** What a scenario gets: a prepared server (or file) and ways to open sessions on it. */
export interface EngineEnv {
  /** Schema name the seeded tables live in, as introspection reports it. */
  readonly schema: string;
  /**
   * True when every session sees the same data (server engines, a SQLite file).
   * False for an in-memory engine where each session is its own database: the
   * env then seeds each new session itself, and ground truth is read through
   * the session under test.
   */
  readonly shared: boolean;
  /** A connected session, generation 1. Closed in `teardown`. */
  open(opts?: OpenOpts): Promise<SqlEngineDriver>;
  /** A driver that has not connected yet. */
  create(): SqlEngineDriver;
  /** Connection config of this env, for scenarios that connect by hand. */
  config(opts?: OpenOpts): ConnectionConfig;
  /** A session separate from the one under test, for ground-truth reads and setup. */
  admin(sql: string, params?: unknown[]): Promise<QueryResult>;
  /** Present when the engine talks over TCP: the proxy `viaProxy` sessions go through. */
  proxy?: FlakyProxy;
  teardown(): Promise<void>;
}

/** One round-trip case: a column type, a value that goes in, what the grid must see. */
export interface TypeCase {
  name: string;
  /** Gate: the case runs only when this capability is on. */
  needs?: CapabilityKey;
  /** Column type DDL. */
  sqlType: string;
  /** SQL expression (a literal) inserted directly. */
  literal: string;
  /** Value bound as a parameter, as the renderer sends it (text). Omitted: no bound run. */
  param?: unknown;
  /** Assertion on the cell the grid receives. */
  expect: (cell: unknown) => void;
  /** Expected `dataTypeName` of the column, when the engine reports a stable one. */
  typeName?: RegExp;
}

/** An engine-specific piece of SQL for every scenario that cannot be written portably. */
export interface SqlFixture {
  /** Short id used in test names and the contract. */
  id: string;
  /** Engine as the app knows it (drives `dialectFor` / `engineCaps`). */
  engine: SqlEngine;
  caps: Capabilities;
  /** Matches the string `connect()` resolves with. */
  versionPattern: RegExp;
  /** Prepares an isolated server database (or temp file); the suite seeds the tables. */
  setup(): Promise<EngineEnv>;
  /**
   * DDL of the canonical fixture tables, names prefixed with `prefix`:
   *   users(id PK, name NOT NULL, age DEFAULT 18, bio), posts(id PK, user_id FK users, title),
   *   pair(a, b, v; PK (a, b)), nokey(a, b; no key), view adults(users with age >= 18).
   * Engines that cannot declare a constraint leave it out and say so in their capabilities.
   */
  ddl(prefix: string): string[];
  /** Objects only the probes need (a function that writes, its log table). */
  extraDdl: string[];

  /** SQL that runs until cancelled (about 30 s). */
  sleepSql: string;
  /** A statement with a syntax error. */
  syntaxErrorSql: string;
  /** A statement the server accepts to parse but fails to run (the session stays usable). */
  runtimeErrorSql: string;
  /** Message the syntax error must carry. */
  syntaxErrorPattern: RegExp;
  /** Extra assertions on the syntax error (a position, a code) where the engine gives one. */
  syntaxErrorExtra?: (err: Error) => void;
  /** `n` rows of one integer column `n`, values 1..n in order. */
  rowsSql(n: number): string;
  /** `n` rows, one text column `s` of about `bytes` characters. */
  wideRowsSql(n: number, bytes: number): string;

  /** Statements a read-only connection must refuse; each against the seeded tables. */
  writeProbes: string[];
  /**
   * Sequences of calls a user could use to turn a read-only session writable.
   * Each inner array is run as separate `query()` calls; the final one writes.
   * A multi-statement entry is sent as one call.
   */
  bypassProbes: string[][];
  /** Single statements `aiQuery()` must refuse although they look like reads or hide writes. */
  aiWriteProbes: string[];
  /** Statement the aiQuery path must still run. */
  aiReadSql: string;
  /**
   * Effects a probe may have had that row counts cannot show (a sequence moved, a file or table
   * created, a pragma changed). Returns a description when something leaked, else undefined.
   */
  probeSideEffects?: (env: EngineEnv, session: SqlEngineDriver) => Promise<string | undefined>;

  /**
   * After a scenario that drops the connection under a running statement: stop what the server
   * is still running for it (a dropped socket does not stop a CPU-bound query), so dropping
   * the scratch database afterwards does not wait on it.
   */
  cleanupAfterLoss?: (env: EngineEnv) => Promise<void>;

  typeCases: TypeCase[];
  /** Nullable text column type, for the empty-string-versus-NULL and unicode cases. */
  textType: string;
  /**
   * `CREATE TABLE` of a scratch table `(id integer, v <valueType>)`; `valueType` is nullable.
   * Default: `CREATE TABLE name (id INTEGER NOT NULL, v valueType)`.
   */
  tableOf?: (name: string, valueType: string) => string;
}
