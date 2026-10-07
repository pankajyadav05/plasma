/**
 * Capability flags of the driver conformance suite.
 *
 * Every engine runs the same scenarios. An engine may skip one only by
 * declaring `{ no: '<why>' }` for the matching key in its fixture: the
 * scenario then still shows up in the report as a skipped test carrying the
 * reason, so an opt-out is always visible and always argued. There is no
 * other way to leave a scenario out (see `docs/driver-contract.md`).
 */

/** One capability: supported (`true`) or explicitly not, with the reason. */
export type Cap = true | { no: string };

/** What each key gates. The list is also checked against the fixtures. */
export const CAPABILITY_DOCS = {
  reconnect: 'The same driver instance connects again after `disconnect()`.',
  badCredentials: 'A wrong password is refused at connect time, without echoing the password.',
  primaryKeys: 'Introspection reports primary-key columns (and their order).',
  foreignKeys: 'Introspection reports foreign keys.',
  transactions: 'begin / commit / rollback are real, and `txnState` follows the server.',
  multiStatement: 'A script of several statements runs; the last statement answers.',
  constraints: 'Key, unique and NOT NULL violations are errors that write nothing.',
  userTransactions:
    'A BEGIN / COMMIT typed by the user is a real transaction, and lookups never disturb it.',
  errorKeepsSession: 'A failed statement leaves the connection usable.',
  cancel: 'A running statement is stopped by `cancelQuery()` within 2 s.',
  statementTimeout: 'The connect-time statement timeout stops a slow statement.',
  readOnlyConnection: 'A connection opened read-only refuses writes and DDL.',
  readOnlyBypass: 'A read-only connection cannot be flipped back to read-write by the user.',
  aiQuery: '`aiQuery()` runs one read-only statement and refuses writes.',
  rowEdit: '`commitEditBatch()` applies keyed update / insert / delete.',
  keylessEdit: 'Rows of a table without a primary key are editable through a row locator.',
  resultCap: 'Row cap with the `truncated` flag.',
  byteCap: 'Byte cap with the `truncated` flag.',
  exportStream: '`streamQueryForExport()` streams past the display cap.',
  connectionLoss: 'A dropped connection is reported as a connection-lost error; reconnect works.',
  exactDecimal: 'DECIMAL / NUMERIC values keep every digit.',
  bigint: 'Integers beyond 2^53 keep every digit.',
  timestamptz: 'A timestamp with a time zone keeps its instant.',
  json: 'A JSON column.',
  binary: 'A binary / blob column (shown as `\\x` + hex text).',
  arrays: 'Array columns.',
} as const;

export type CapabilityKey = keyof typeof CAPABILITY_DOCS;

export type Capabilities = Record<CapabilityKey, Cap>;

export const CAPABILITY_KEYS = Object.keys(CAPABILITY_DOCS) as CapabilityKey[];

/** Everything on; engines override what they cannot do. */
export function allCapabilities(overrides: Partial<Record<CapabilityKey, Cap>>): Capabilities {
  const caps = {} as Capabilities;
  for (const key of CAPABILITY_KEYS) caps[key] = overrides[key] ?? true;
  return caps;
}

/** The reason when `cap` is an opt-out, otherwise null. */
export function optOutReason(cap: Cap): string | null {
  return cap === true ? null : cap.no;
}
