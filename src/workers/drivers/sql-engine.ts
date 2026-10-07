import type {
  ConnectionConfig,
  IntrospectOpts,
  QueryResult,
  SchemaInfo,
  TxnState,
} from '@shared/protocol';

/** Options every SQL engine driver understands on `query`. */
export interface SqlQueryOpts {
  revision?: number;
  /** Editor row limit; defaults to the MAX_RESULT_ROWS safety cap. */
  maxRows?: number;
  /** Retained-bytes cap for this result. */
  maxBytes?: number;
  /** Transaction mode: BEGIN first when the session is idle. */
  autoBegin?: boolean;
  /** Sideband only: run read-only under this timeout. */
  timeoutMs?: number;
  /** Raise the MAX_RESULT_ROWS ceiling for this read (Result Compare); `maxRows` is then honoured up to it. */
  rowCeiling?: number;
}

/**
 * A cancel was attempted and the server did not confirm it (no answer, refused).
 * Distinct from `false` ("nothing was in flight"): the statement may still run.
 */
export class CancelFailedError extends Error {
  override readonly name = 'CancelFailedError';
  constructor(reason: string) {
    super(`cancel failed: ${reason}`);
  }
}

/** Read options for the agent / compare path: the agent's 1000-row default, or the caller's cap. */
export function aiReadOpts(opts?: AiQueryOpts): SqlQueryOpts {
  return opts?.maxRows ? { maxRows: opts.maxRows, rowCeiling: opts.maxRows } : { maxRows: 1000 };
}

/** Options of the read-only agent / compare query path. */
export interface AiQueryOpts {
  /** Rows to keep (default: the engine's agent cap). */
  maxRows?: number;
}

export interface SqlEditUpdate {
  sql: string;
  params?: unknown[];
  label?: string;
}

export interface ExportBatch {
  columns: QueryResult['columns'];
  rows: unknown[][];
}

/**
 * The slice of a driver the worker dispatches SQL-workbench requests to
 * (query, edits, transactions, explain, export, introspection). The
 * Postgres, SQLite and MySQL drivers all provide it; ops outside it
 * (Safe Run, import, DDL apply) stay Postgres-only.
 */
export interface SqlEngineDriver {
  connect(config: ConnectionConfig, statementTimeoutMs?: number): Promise<string>;
  disconnect(): Promise<void>;
  query(sql: string, params?: unknown[], opts?: SqlQueryOpts): Promise<QueryResult>;
  sidebandQuery(sql: string, params?: unknown[], opts?: SqlQueryOpts): Promise<QueryResult>;
  aiQuery(sql: string, params?: unknown[], opts?: AiQueryOpts): Promise<QueryResult>;
  explain(sql: string, analyze: boolean, params?: unknown[]): Promise<QueryResult>;
  cancelQuery(): Promise<boolean>;
  cancelAux(): Promise<boolean>;
  beginTransaction(): Promise<TxnState>;
  commitTransaction(): Promise<TxnState>;
  rollbackTransaction(): Promise<TxnState>;
  commitEditBatch(
    expectedGen: number,
    updates: SqlEditUpdate[],
  ): Promise<{ state: TxnState; applied: number }>;
  streamQueryForExport(sql: string, params?: unknown[]): AsyncGenerator<ExportBatch, void, void>;
  introspect(opts?: IntrospectOpts): Promise<SchemaInfo>;
  setConnectionGen(gen: number): void;
  lostDuringTransaction(): boolean;
}
