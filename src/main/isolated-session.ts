import { randomUUID } from 'node:crypto';
import { sshUnsupportedReason } from '@shared/connection-endpoint';
import type {
  ConnectionConfig,
  QueryResult,
  SchemaInfo,
  Settings,
  WorkerRequest,
  WorkerResponse,
} from '@shared/protocol';
import { isSqlEngine } from '@shared/sql-dialect';
import { assertTlsAllowedForTag, resolveTls, withTunnelServername } from '@shared/tls';
import { buildDuckdbAttachments } from './data-files';

/**
 * Throwaway sessions on saved connections that are not the live one: TLS
 * files, DuckDB attachments, an SSH tunnel when the connection has one, the
 * TLS-by-tag gate; the worker runs the statement (or introspection) in its own
 * read-only driver and closes it. The live session is never touched. Used by
 * Result Compare and by the MCP server.
 *
 * Everything that needs Electron (vault, worker, tunnels, history) is passed
 * in, so the whole path runs in tests.
 */

type DistributiveOmit<T, K extends keyof T> = T extends T ? Omit<T, K> : never;
type Reply<K extends WorkerResponse['kind']> = Extract<WorkerResponse, { kind: K }>;

export interface IsolatedDeps {
  /** The saved connection (workspace profile first), with its password. */
  resolveConfig(id: string): ConnectionConfig | null;
  /** A saved connection with its password, for DuckDB attachments. */
  loadSaved(id: string): ReturnType<Parameters<typeof buildDuckdbAttachments>[1]['load']>;
  settings(): Settings;
  withTlsFiles(config: ConnectionConfig): Promise<ConnectionConfig>;
  sshFor(id: string, settings: Settings): { host: string; port: number } | object | null;
  openTunnel(target: { id: string; ssh: never; pgHost: string; pgPort: number }): Promise<{
    host: string;
    port: number;
  }>;
  closeTunnel(id: string): void;
  callWorker<K extends WorkerResponse['kind']>(
    req: DistributiveOmit<WorkerRequest, 'id'>,
    kind: K,
  ): Promise<Reply<K>>;
  recordHistory(entry: {
    connectionId: string;
    sql: string;
    rowCount: number | null;
    durationMs: number | null;
    error: string | null;
    executedAt: number;
  }): void;
  log(message: string, err: unknown): void;
}

export function createIsolatedSessions(deps: IsolatedDeps) {
  async function withIsolatedSession<T>(
    connectionId: string,
    fn: (effective: ConnectionConfig) => Promise<T>,
  ): Promise<T> {
    const config = deps.resolveConfig(connectionId);
    if (!config) throw new Error('That connection is not saved any more.');
    if (!isSqlEngine(config.engine ?? 'postgres')) {
      throw new Error(
        'Compare needs a SQL connection (Postgres, MySQL, SQLite, ClickHouse, DuckDB).',
      );
    }
    const settings = deps.settings();
    assertTlsAllowedForTag(resolveTls(config), settings.connectionTags?.[config.id]);
    const tunnelKey = `compare:${randomUUID()}`;
    let tunnelled = false;
    try {
      let effective: ConnectionConfig = await deps.withTlsFiles(config);
      if (config.engine === 'duckdb' && config.duckdb?.attachConnectionIds?.length) {
        // Saved Postgres connections attached read-only, resolved here with their stored passwords.
        effective = {
          ...effective,
          duckdb: {
            files: config.duckdb.files,
            installPostgresExtension: config.duckdb.installPostgresExtension,
            installExcelExtension: config.duckdb.installExcelExtension,
            attach: buildDuckdbAttachments(config.duckdb.attachConnectionIds, {
              load: (id) => deps.loadSaved(id),
              sshFor: (id) => deps.sshFor(id, settings) !== null,
            }),
          },
        };
      }
      const ssh = deps.sshFor(config.id, settings);
      if (ssh) {
        const refusal = sshUnsupportedReason(config);
        if (refusal) throw new Error(refusal);
        const local = await deps.openTunnel({
          id: tunnelKey,
          ssh: ssh as never,
          pgHost: config.host,
          pgPort: config.port,
        });
        tunnelled = true;
        effective = {
          ...withTunnelServername(effective, config.host),
          host: local.host,
          port: local.port,
        };
      }
      return await fn(effective);
    } finally {
      if (tunnelled) deps.closeTunnel(tunnelKey);
    }
  }

  /**
   * One read-only statement: a throwaway read-only session (tunnel included)
   * that is closed right after, recorded in history.
   */
  function runIsolatedRead(
    connectionId: string,
    sql: string,
    maxRows: number,
    opts: { runId?: string; timeoutMs?: number } = {},
  ): Promise<QueryResult> {
    return withIsolatedSession(connectionId, async (effective) => {
      const executedAt = Date.now();
      try {
        const res = await deps.callWorker(
          {
            kind: 'compareQuery',
            config: { ...effective, readOnly: true },
            sql,
            maxRows,
            runId: opts.runId ?? randomUUID(),
            ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
          },
          'queryResult',
        );
        try {
          deps.recordHistory({
            connectionId,
            sql,
            rowCount: res.result.rowCount,
            durationMs: res.result.durationMs,
            error: null,
            executedAt,
          });
        } catch (err) {
          deps.log('[plasma] history write failed (non-fatal):', err);
        }
        return res.result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          deps.recordHistory({
            connectionId,
            sql,
            rowCount: null,
            durationMs: null,
            error: message,
            executedAt,
          });
        } catch {}
        throw err;
      }
    });
  }

  function introspectIsolated(connectionId: string): Promise<SchemaInfo> {
    return withIsolatedSession(connectionId, async (effective) => {
      const res = await deps.callWorker(
        { kind: 'compareSchema', config: { ...effective, readOnly: true } },
        'schemaInfo',
      );
      return res.info;
    });
  }

  return { runIsolatedRead, introspectIsolated };
}
