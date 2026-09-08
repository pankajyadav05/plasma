import { type AddressInfo, type Server, type Socket, createServer } from 'node:net';

/**
 * Minimal Postgres wire-protocol server for connection-lifecycle tests.
 *
 * Speaks just enough of the v3 protocol for `pg.Client` to connect and
 * run simple queries (`SELECT 1`, `SELECT version()`, `SELECT
 * pg_backend_pid()`), which is what the U27 liveness paths exercise.
 * Extended-protocol (cursor) traffic is intentionally out of scope.
 *
 * The point is the failure modes a VPN drop produces, which no real
 * server can be asked for on demand:
 *   - `killSockets()` — peer vanishes and the socket is reset
 *   - `stallSockets()` — half-open sockets: writes are accepted, nothing
 *     ever comes back (the case that hangs a query forever), while new
 *     connections still work
 */
export class FakePostgres {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly stalled = new Set<Socket>();
  /** Simple-query strings the server answered, in order. */
  readonly queries: string[] = [];

  private constructor(server: Server) {
    this.server = server;
  }

  static async start(): Promise<FakePostgres> {
    const server = createServer();
    const fake = new FakePostgres(server);
    server.on('connection', (socket) => fake.handle(socket));
    // `Promise.withResolvers` needs lib es2024; this project targets ES2022.
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return fake;
  }

  get port(): number {
    const address = this.server.address() as AddressInfo;
    return address.port;
  }

  /**
   * Existing sockets stop answering while staying open — the half-open
   * peer a VPN drop leaves behind. New connections are unaffected, which
   * is what "the VPN came back" looks like from the client's side.
   */
  stallSockets(): void {
    for (const socket of this.sockets) this.stalled.add(socket);
  }

  /** Destroy every live socket without a graceful close — a reset peer. */
  killSockets(): void {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  get openSockets(): number {
    return this.sockets.size;
  }

  async stop(): Promise<void> {
    this.killSockets();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(socket: Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => this.sockets.delete(socket));

    let buffer = Buffer.alloc(0);
    let started = false;
    let prepared = '';

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      // The startup packet has no type byte: 4-byte length, then payload.
      if (!started) {
        if (buffer.length < 4) return;
        const length = buffer.readInt32BE(0);
        if (buffer.length < length) return;
        buffer = buffer.subarray(length);
        started = true;
        if (this.stalled.has(socket)) return;
        socket.write(
          Buffer.concat([
            authenticationOk(),
            parameterStatus('server_version', '16.6 (fake)'),
            backendKeyData(4242, 1),
            readyForQuery(),
          ]),
        );
      }

      // Prepared statement text carried from Parse to Execute so a
      // cursor read can answer with the matching column.
      while (buffer.length >= 5) {
        const type = String.fromCharCode(buffer[0]);
        const length = buffer.readInt32BE(1);
        if (buffer.length < length + 1) return;
        const body = buffer.subarray(5, length + 1);
        buffer = buffer.subarray(length + 1);

        if (type === 'X') {
          socket.end();
          return;
        }
        const stalledSocket = this.stalled.has(socket);

        if (type === 'Q') {
          const sql = body.subarray(0, body.length - 1).toString('utf8');
          this.queries.push(sql);
          if (stalledSocket) continue;
          socket.write(Buffer.concat(answerSimpleQuery(sql)));
          continue;
        }

        // Extended protocol — what pg-cursor uses for user queries.
        if (type === 'P') {
          // Parse: statement name, then query text, both null-terminated.
          const nameEnd = body.indexOf(0);
          const textEnd = body.indexOf(0, nameEnd + 1);
          prepared = body.subarray(nameEnd + 1, textEnd).toString('utf8');
          this.queries.push(prepared);
          if (!stalledSocket) socket.write(message('1', Buffer.alloc(0)));
          continue;
        }
        if (type === 'B') {
          if (!stalledSocket) socket.write(message('2', Buffer.alloc(0)));
          continue;
        }
        if (type === 'D') {
          if (!stalledSocket) socket.write(describeAnswer(prepared));
          continue;
        }
        if (type === 'E') {
          if (!stalledSocket) socket.write(Buffer.concat(executeAnswer(prepared)));
          continue;
        }
        if (type === 'C') {
          if (!stalledSocket) socket.write(message('3', Buffer.alloc(0)));
          continue;
        }
        if (type === 'S') {
          if (!stalledSocket) socket.write(readyForQuery());
        }
      }
    });
  }
}

function message(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.write(type, 0, 'latin1');
  header.writeInt32BE(payload.length + 4, 1);
  return Buffer.concat([header, payload]);
}

function cstring(value: string): Buffer {
  return Buffer.concat([Buffer.from(value, 'utf8'), Buffer.from([0])]);
}

function authenticationOk(): Buffer {
  const payload = Buffer.alloc(4);
  payload.writeInt32BE(0, 0);
  return message('R', payload);
}

function parameterStatus(name: string, value: string): Buffer {
  return message('S', Buffer.concat([cstring(name), cstring(value)]));
}

function backendKeyData(pid: number, secret: number): Buffer {
  const payload = Buffer.alloc(8);
  payload.writeInt32BE(pid, 0);
  payload.writeInt32BE(secret, 4);
  return message('K', payload);
}

function readyForQuery(): Buffer {
  return message('Z', Buffer.from('I', 'latin1'));
}

/** One text column named `col` holding `value`. */
function rowDescription(name: string): Buffer {
  const field = Buffer.alloc(18);
  field.writeInt32BE(0, 0); // table oid
  field.writeInt16BE(0, 4); // column attr
  field.writeInt32BE(25, 6); // type oid: text
  field.writeInt16BE(-1, 10); // type size
  field.writeInt32BE(-1, 12); // type modifier
  field.writeInt16BE(0, 16); // text format
  const count = Buffer.alloc(2);
  count.writeInt16BE(1, 0);
  return message('T', Buffer.concat([count, cstring(name), field]));
}

function dataRow(value: string): Buffer {
  const count = Buffer.alloc(2);
  count.writeInt16BE(1, 0);
  const bytes = Buffer.from(value, 'utf8');
  const size = Buffer.alloc(4);
  size.writeInt32BE(bytes.length, 0);
  return message('D', Buffer.concat([count, size, bytes]));
}

function commandComplete(tag: string): Buffer {
  return message('C', cstring(tag));
}

function resultShape(sql: string): { column: string; value: string } {
  const lower = sql.toLowerCase();
  if (lower.includes('pg_backend_pid')) return { column: 'pid', value: '4242' };
  if (lower.includes('version()')) return { column: 'version', value: 'PostgreSQL 16.6 (fake)' };
  return { column: 'col', value: '1' };
}

function answerSimpleQuery(sql: string): Buffer[] {
  const lower = sql.toLowerCase();
  // SET / BEGIN / COMMIT style statements produce no rows.
  if (lower.startsWith('set ') || lower.startsWith('begin') || lower.startsWith('commit')) {
    return [commandComplete(sql.trim().split(/\s+/)[0].toUpperCase()), readyForQuery()];
  }
  const { column, value } = resultShape(sql);
  return [rowDescription(column), dataRow(value), commandComplete('SELECT 1'), readyForQuery()];
}

/** Answer to a portal Describe: one column, or NoData for row-less SQL. */
function describeAnswer(sql: string): Buffer {
  const lower = sql.trim().toLowerCase();
  if (lower.startsWith('set ') || lower.startsWith('begin') || lower.startsWith('commit')) {
    return message('n', Buffer.alloc(0));
  }
  return rowDescription(resultShape(sql).column);
}

/** Answer to Execute: the single row this fake serves, then completion. */
function executeAnswer(sql: string): Buffer[] {
  const lower = sql.trim().toLowerCase();
  if (lower.startsWith('set ') || lower.startsWith('begin') || lower.startsWith('commit')) {
    return [commandComplete(lower.split(/\s+/)[0].toUpperCase())];
  }
  return [dataRow(resultShape(sql).value), commandComplete('SELECT 1')];
}
