import { agentReadSandboxed, isAgentReadSql } from '@shared/ai-readonly-sql';
import { describeDbErrorSafely } from '@shared/db-error-class';
import {
  MCP_DEFAULT_ROWS,
  MCP_MAX_ROWS,
  MCP_SCHEMA_CACHE_MS,
  type McpAccess,
  type McpOutcome,
  accessAtLeast,
  resolveConnectionRef,
} from '@shared/mcp';
import type { QueryResult, SchemaInfo } from '@shared/protocol';
import { compactSchema } from '@shared/schema-compact';
import { isSqlEngine } from '@shared/sql-dialect';
import { isSingleSqlStatement } from '@shared/sql-statements';
import { serializeAiToolRows } from '../ai-policy';
import { type McpToolDef, type McpToolResult, type ToolContext, textResult } from './protocol';

/**
 * The tools an MCP client sees. Everything Plasma-specific is injected
 * (`McpToolsDeps`), so this file is tested with fakes and never touches a
 * socket, the vault or Electron.
 *
 * What never appears in a tool result: host, port, user, password, file
 * paths. `list_connections` is built from an allow-list of fields; errors
 * pass through `deps.scrub`.
 */

export interface McpConnectionInfo {
  id: string;
  name: string;
  engine: string;
  readOnly: boolean;
  /** Tagged production. */
  production: boolean;
  /** Already clamped by `effectiveAccess` (read-only connections never reach `propose`). */
  access: McpAccess;
  unmasked: boolean;
  openInPlasma: boolean;
}

export type ProposeOutcome =
  | { kind: 'applied'; note?: string; rowsAffected?: number }
  | { kind: 'declined'; note?: string }
  | { kind: 'failed'; note: string }
  | { kind: 'timeout' }
  | { kind: 'busy'; note: string };

export interface McpAuditInput {
  client: string;
  tool: string;
  connectionId: string | null;
  connectionName: string;
  sql: string;
  outcome: McpOutcome;
  rows: number | null;
  durationMs: number;
  error?: string;
}

export interface McpToolsDeps {
  connections(): McpConnectionInfo[];
  runRead(
    connectionId: string,
    sql: string,
    maxRows: number,
    signal: AbortSignal,
  ): Promise<QueryResult>;
  schema(connectionId: string, signal: AbortSignal): Promise<SchemaInfo>;
  /** Masked copy of `rows` (always, unless the connection's switch is on). */
  maskRows(
    connectionId: string,
    columns: ReadonlyArray<{ name: string; dataTypeName?: string | null }>,
    rows: unknown[][],
  ): unknown[][];
  propose(input: {
    connectionId: string;
    connectionName: string;
    client: string;
    sql: string;
    summary: string;
    signal: AbortSignal;
  }): Promise<ProposeOutcome>;
  /** Error text with the connection's host, user and password removed. */
  scrub(connectionId: string | null, text: string): string;
  audit(entry: McpAuditInput): void;
  now(): number;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

const ANNOTATIONS = {
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  write: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
} as const;

export const MCP_INSTRUCTIONS = [
  "Plasma gives you the user's databases, only the ones they turned on for AI tools.",
  'Call list_connections first. Use get_schema before writing SQL, then run_query for read-only SELECTs.',
  'Values may be masked. Never ask for or guess passwords or hosts: you cannot get them.',
  'To change data call propose_change: the user must approve it in Plasma, and it can only target the connection open in Plasma right now. Say what the change is for in `summary`.',
].join(' ');

export function mcpToolDefs(): McpToolDef[] {
  const connection = {
    type: 'string',
    description: 'Connection id or exact name from list_connections.',
  };
  return [
    {
      name: 'list_connections',
      title: 'List connections',
      description:
        'Databases the user allows AI tools to use: id, name, engine, access level (schema, read or propose), whether it is read-only, production, and open in Plasma.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: ANNOTATIONS.read,
    },
    {
      name: 'get_schema',
      title: 'Get schema',
      description:
        'Tables, columns, types, primary and foreign keys of a connection. Pass schema and table to narrow it; with a table it also lists indexes.',
      inputSchema: {
        type: 'object',
        properties: {
          connection,
          schema: { type: 'string', description: 'Only this schema.' },
          table: {
            type: 'string',
            description: 'Only this table (needs schema, or matches any schema).',
          },
        },
        required: ['connection'],
        additionalProperties: false,
      },
      annotations: ANNOTATIONS.read,
    },
    {
      name: 'run_query',
      title: 'Run a read-only query',
      description: `Run ONE read-only SQL statement (SELECT, WITH, EXPLAIN, SHOW, VALUES, TABLE) in a read-only session. Returns up to max_rows rows (default ${MCP_DEFAULT_ROWS}, max ${MCP_MAX_ROWS}) as JSON with a truncated flag. Sensitive columns are masked. 30 second limit.`,
      inputSchema: {
        type: 'object',
        properties: {
          connection,
          sql: { type: 'string', description: 'One read-only statement.' },
          max_rows: { type: 'integer', minimum: 1, maximum: MCP_MAX_ROWS },
        },
        required: ['connection', 'sql'],
        additionalProperties: false,
      },
      annotations: ANNOTATIONS.read,
    },
    {
      name: 'propose_change',
      title: 'Propose a change',
      description:
        'Propose ONE statement that changes data or schema. Nothing runs until the user approves it in Plasma. Only works on the connection currently open in Plasma. Waits up to 10 minutes for the answer and returns what happened.',
      inputSchema: {
        type: 'object',
        properties: {
          connection,
          sql: { type: 'string', description: 'One INSERT, UPDATE, DELETE or DDL statement.' },
          summary: { type: 'string', description: 'One sentence: what this does and why.' },
        },
        required: ['connection', 'sql', 'summary'],
        additionalProperties: false,
      },
      annotations: ANNOTATIONS.write,
    },
    // TRACK M: the memory tools (get_memory, remember) are added here after both tracks merge.
  ];
}

const json = (v: unknown) => JSON.stringify(v);
const err = (message: string) => textResult(message, true);

/** A cell as JSON can carry it. */
function jsonCell(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (v instanceof Uint8Array) return '[binary]';
  if (typeof v === 'string' && v.length > 2000) return `${v.slice(0, 2000)}…`;
  return v;
}

/** Filter a schema to what was asked for. */
export function narrowSchema(info: SchemaInfo, schema?: string, table?: string): SchemaInfo {
  const keep = (s: string, t: string) =>
    (schema === undefined || s === schema) && (table === undefined || t === table);
  return {
    ...info,
    schemas: info.schemas.filter((s) => schema === undefined || s.name === schema),
    tables: info.tables.filter((t) => keep(t.schema, t.name)),
    columns: info.columns.filter((c) => keep(c.schema, c.table)),
    foreignKeys: info.foreignKeys.filter((f) => keep(f.schema, f.table)),
    indexes: info.indexes?.filter((i) => keep(i.schema, i.table)),
  };
}

export function createMcpTools(deps: McpToolsDeps) {
  const schemaCache = new Map<string, { at: number; info: SchemaInfo }>();

  async function schemaOf(id: string, signal: AbortSignal): Promise<SchemaInfo> {
    const hit = schemaCache.get(id);
    if (hit && deps.now() - hit.at < MCP_SCHEMA_CACHE_MS) return hit.info;
    const info = await deps.schema(id, signal);
    schemaCache.set(id, { at: deps.now(), info });
    return info;
  }

  const visible = () => deps.connections().filter((c) => c.access !== 'off');

  /** Resolve `connection` and check the access level: the connection, or the error to return. */
  function pick(
    args: Record<string, unknown>,
    need: McpAccess,
  ): { ok: true; conn: McpConnectionInfo } | { ok: false; result: McpToolResult } {
    const list = visible();
    const r = resolveConnectionRef(args.connection, list);
    if (!r.ok) return { ok: false, result: err(r.error) };
    const conn = list.find((c) => c.id === r.id) as McpConnectionInfo;
    if (!accessAtLeast(conn.access, need)) {
      const what =
        need === 'schema' ? 'structure' : need === 'read' ? 'read queries' : 'proposed changes';
      return {
        ok: false,
        result: err(
          `${conn.name} does not allow ${what} for AI tools. The user can change this in Plasma: Settings, MCP server.`,
        ),
      };
    }
    return { ok: true, conn };
  }

  const dbError = (conn: McpConnectionInfo, e: unknown): string => {
    const raw = e instanceof Error ? e.message : String(e);
    return deps.scrub(conn.id, raw).split('\n')[0]?.slice(0, 400) || describeDbErrorSafely(raw);
  };

  async function call(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<McpToolResult> {
    const started = deps.now();
    const audit = (
      conn: McpConnectionInfo | null,
      outcome: McpOutcome,
      extra: { sql?: string; rows?: number | null; error?: string } = {},
    ) =>
      deps.audit({
        client: ctx.client,
        tool: name,
        connectionId: conn?.id ?? null,
        connectionName: conn?.name ?? '',
        sql: extra.sql ?? '',
        outcome,
        rows: extra.rows ?? null,
        durationMs: deps.now() - started,
        ...(extra.error ? { error: extra.error } : {}),
      });

    switch (name) {
      case 'list_connections': {
        const out = visible().map((c) => ({
          id: c.id,
          name: c.name,
          engine: c.engine,
          access: c.access,
          readOnly: c.readOnly,
          production: c.production,
          openInPlasma: c.openInPlasma,
        }));
        audit(null, 'ok', { rows: out.length });
        return textResult(json(out));
      }

      case 'get_schema': {
        const p = pick(args, 'schema');
        if (!p.ok) {
          audit(null, 'denied', { error: 'access' });
          return p.result;
        }
        const { conn } = p;
        if (!isSqlEngine(conn.engine as never)) {
          audit(conn, 'error', { error: 'engine' });
          return err(`Structure of ${conn.engine} connections is not supported over MCP yet.`);
        }
        const schema = str(args.schema)?.trim() || undefined;
        const table = str(args.table)?.trim() || undefined;
        try {
          const info = await schemaOf(conn.id, ctx.signal);
          const narrow = narrowSchema(info, schema, table);
          const text = compactSchema(narrow, {
            withIndexes: table !== undefined,
            maxTables: schema || table ? 200 : 400,
            maxCols: table ? 200 : 40,
          });
          audit(conn, 'ok', { rows: narrow.tables.length });
          if (!text) return err('No matching tables.');
          return textResult(text);
        } catch (e) {
          const message = dbError(conn, e);
          audit(conn, 'error', { error: message });
          return err(message);
        }
      }

      case 'run_query': {
        const p = pick(args, 'read');
        if (!p.ok) {
          audit(null, 'denied', { error: 'access' });
          return p.result;
        }
        const { conn } = p;
        const sql = str(args.sql)?.trim() ?? '';
        if (!sql) return err('sql is required.');
        if (!agentReadSandboxed(conn.engine)) {
          audit(conn, 'error', { sql, error: 'engine' });
          return err(`Queries on ${conn.engine} connections are not supported over MCP yet.`);
        }
        if (!isSingleSqlStatement(sql)) {
          audit(conn, 'denied', { sql, error: 'not one statement' });
          return err('Send exactly one statement per call.');
        }
        if (!isAgentReadSql(sql)) {
          audit(conn, 'denied', { sql, error: 'not read-only' });
          return err(
            'run_query is for read-only statements (SELECT, WITH, EXPLAIN, SHOW, VALUES, TABLE). Use propose_change to change data.',
          );
        }
        const asked =
          typeof args.max_rows === 'number' && Number.isFinite(args.max_rows)
            ? Math.floor(args.max_rows)
            : MCP_DEFAULT_ROWS;
        const maxRows = Math.min(Math.max(asked, 1), MCP_MAX_ROWS);
        try {
          // One extra row tells us whether there was more.
          const res = await deps.runRead(conn.id, sql, maxRows + 1, ctx.signal);
          const more = res.rows.length > maxRows || res.rowCount > maxRows;
          const taken = res.rows.slice(0, maxRows);
          const masked = deps.maskRows(conn.id, res.columns, taken).map((r) => r.map(jsonCell));
          const text = serializeAiToolRows({
            columns: res.columns.map((c) => c.name),
            rows: masked,
            rowCount: more ? Math.max(res.rowCount, maxRows + 1) : taken.length,
            maxRows,
            maxBytes: 120_000,
          });
          audit(conn, 'ok', { sql, rows: taken.length });
          // `truncated` is set by the serializer when a cap bit; also when we cut at maxRows.
          return textResult(more ? withTruncated(text) : text);
        } catch (e) {
          const message = dbError(conn, e);
          audit(conn, 'error', { sql, error: message });
          return err(message);
        }
      }

      case 'propose_change': {
        const p = pick(args, 'propose');
        if (!p.ok) {
          audit(null, 'denied', { error: 'access' });
          return p.result;
        }
        const { conn } = p;
        const sql = str(args.sql)?.trim() ?? '';
        const summary = str(args.summary)?.trim() ?? '';
        if (!sql) return err('sql is required.');
        if (conn.readOnly) {
          audit(conn, 'denied', { sql, error: 'read-only' });
          return err(`${conn.name} is read-only. Nothing was changed.`);
        }
        if (!conn.openInPlasma) {
          audit(conn, 'denied', { sql, error: 'not open' });
          return err(`Open ${conn.name} in Plasma first, then try again.`);
        }
        const out = await deps.propose({
          connectionId: conn.id,
          connectionName: conn.name,
          client: ctx.client,
          sql,
          summary,
          signal: ctx.signal,
        });
        switch (out.kind) {
          case 'applied':
            audit(conn, 'ok', { sql, rows: out.rowsAffected ?? null });
            return textResult(
              json({
                outcome: 'applied',
                ...(out.note ? { note: out.note } : {}),
                ...(out.rowsAffected !== undefined ? { rowsAffected: out.rowsAffected } : {}),
              }),
            );
          case 'declined':
            audit(conn, 'declined', { sql });
            return textResult(
              json({
                outcome: 'declined',
                note: out.note ?? 'The user declined. Nothing was changed.',
              }),
            );
          case 'timeout':
            audit(conn, 'declined', { sql, error: 'no answer' });
            return textResult('No answer in Plasma; nothing was changed.', true);
          case 'busy':
            audit(conn, 'denied', { sql, error: 'busy' });
            return err(out.note);
          case 'failed': {
            const message = deps.scrub(conn.id, out.note);
            audit(conn, 'error', { sql, error: message });
            return textResult(json({ outcome: 'failed', note: message }), true);
          }
        }
        return err('Unexpected answer.');
      }

      default:
        return err(`Unknown tool: ${name.slice(0, 80)}`);
    }
  }

  return { defs: mcpToolDefs, call, clearCache: () => schemaCache.clear() };
}

function withTruncated(text: string): string {
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    return JSON.stringify({ ...o, truncated: true });
  } catch {
    return text;
  }
}
