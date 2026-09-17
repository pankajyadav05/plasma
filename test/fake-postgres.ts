import { type AddressInfo, type Server, type Socket, createServer } from 'node:net';

/**
 * Minimal Postgres wire-protocol server for connection-lifecycle and
 * transaction-state tests.
 *
 * Speaks just enough of the v3 protocol for `pg.Client` to connect, run
 * simple queries (`SELECT 1`, `SELECT version()`, `SELECT
 * pg_backend_pid()`), and run extended-protocol (cursor) queries.
 *
 * Transaction state is tracked per socket so ReadyForQuery reports the
 * real status byte ('I' idle / 'T' in-transaction / 'E' aborted), which
 * is what the driver's txnState mirror keys off. `failNext()` injects a
 * server error on the next statement.
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
  /** Simple-query strings + extended-protocol Parse texts, in order. */
  readonly queries: string[] = [];
  /** ReadyForQuery status bytes sent per answered statement, in order. */
  readonly statuses: string[] = [];
  /** Per-socket transaction status (keyed by socket for assertions). */
  private readonly txnBySocket = new Map<Socket, 'I' | 'T' | 'E'>();
  private pendingFailure: { code: string; message: string; match?: RegExp } | null = null;

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
   * Make the next statement (simple Query or extended Execute) on any
   * socket fail with the given SQLSTATE and message. Inside an active
   * transaction this also moves that socket to the aborted state.
   */
  failNext(code: string, message: string): void {
    this.pendingFailure = { code, message };
  }

  /**
   * Like `failNext`, but the failure lands on the next statement whose
   * text matches `match` — later statements in a multi-statement run can
   * be targeted while the earlier ones succeed.
   */
  failOn(match: RegExp, code: string, message: string): void {
    this.pendingFailure = { code, message, match };
  }

  /** Transaction status of the most recently seen socket ('I'/'T'/'E'). */
  get txnStatus(): string {
    const states = [...this.txnBySocket.values()];
    return states[states.length - 1] ?? 'I';
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
    socket.on('close', () => {
      this.sockets.delete(socket);
      this.txnBySocket.delete(socket);
    });
    socket.on('error', () => {
      this.sockets.delete(socket);
      this.txnBySocket.delete(socket);
    });

    let buffer = Buffer.alloc(0);
    let started = false;
    let prepared = '';
    let txn: 'I' | 'T' | 'E' = 'I';
    // After an ErrorResponse in the extended protocol the backend ignores
    // Parse/Bind/Describe/Execute/Close until the client sends Sync.
    let discardUntilSync = false;

    const ready = (): Buffer => {
      this.txnBySocket.set(socket, txn);
      this.statuses.push(txn);
      return readyForQuery(txn);
    };

    /**
     * Apply the transaction transitions for one statement and answer it.
     * Returns the messages to send, or null when the caller should stay
     * silent (stalled socket / discard-until-Sync).
     */
    const answer = (sql: string, extended: boolean): Buffer[] | null => {
      const keyword = txnKeyword(sql);

      // Injected failure — one statement, then back to normal service.
      if (
        this.pendingFailure &&
        (!this.pendingFailure.match || this.pendingFailure.match.test(sql))
      ) {
        const { code, message } = this.pendingFailure;
        this.pendingFailure = null;
        if (txn === 'T') txn = 'E';
        this.txnBySocket.set(socket, txn);
        if (extended) discardUntilSync = true;
        return extended
          ? [errorResponse('ERROR', code, message)]
          : [errorResponse('ERROR', code, message), ready()];
      }

      // Aborted transaction: everything but COMMIT/ROLLBACK/END/ABORT is
      // rejected with 25P02 (this includes the driver's SELECT 1 probe).
      if (txn === 'E' && keyword !== 'commit' && keyword !== 'rollback') {
        if (extended) discardUntilSync = true;
        return extended
          ? [
              errorResponse(
                'ERROR',
                '25P02',
                'current transaction is aborted, commands ignored until end of transaction block',
              ),
            ]
          : [
              errorResponse(
                'ERROR',
                '25P02',
                'current transaction is aborted, commands ignored until end of transaction block',
              ),
              ready(),
            ];
      }

      if (keyword === 'begin') txn = 'T';
      const tag = isRowless(sql) ? rowlessTag(sql, txn) : null;
      if (keyword === 'commit' || keyword === 'rollback') txn = 'I';
      this.txnBySocket.set(socket, txn);

      if (tag) {
        return extended ? [commandComplete(tag)] : [commandComplete(tag), ready()];
      }
      const { column, value } = resultShape(sql);
      return extended
        ? [dataRow(value), commandComplete('SELECT 1')]
        : [rowDescription(column), dataRow(value), commandComplete('SELECT 1'), ready()];
    };

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
            readyForQuery('I'),
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
          discardUntilSync = false;
          if (stalledSocket) continue;
          const messages = answer(sql, false);
          if (messages) socket.write(Buffer.concat(messages));
          continue;
        }

        // Extended protocol — what pg-cursor uses for user queries.
        if (type === 'P') {
          // Parse: statement name, then query text, both null-terminated.
          const nameEnd = body.indexOf(0);
          const textEnd = body.indexOf(0, nameEnd + 1);
          prepared = body.subarray(nameEnd + 1, textEnd).toString('utf8');
          this.queries.push(prepared);
          if (!stalledSocket && !discardUntilSync) socket.write(message('1', Buffer.alloc(0)));
          continue;
        }
        if (type === 'B') {
          if (!stalledSocket && !discardUntilSync) socket.write(message('2', Buffer.alloc(0)));
          continue;
        }
        if (type === 'D') {
          if (!stalledSocket && !discardUntilSync) socket.write(describeAnswer(prepared));
          continue;
        }
        if (type === 'E') {
          if (stalledSocket || discardUntilSync) continue;
          const messages = answer(prepared, true);
          if (messages) socket.write(Buffer.concat(messages));
          continue;
        }
        if (type === 'C') {
          if (!stalledSocket && !discardUntilSync) socket.write(message('3', Buffer.alloc(0)));
          continue;
        }
        if (type === 'S') {
          discardUntilSync = false;
          if (!stalledSocket) socket.write(ready());
        }
      }
    });
  }
}

/** First SQL keyword, skipping leading line/block comments. */
function firstWord(sql: string): string {
  let s = sql.trimStart();
  for (;;) {
    if (s.startsWith('--')) {
      const nl = s.indexOf('\n');
      if (nl === -1) return '';
      s = s.slice(nl + 1).trimStart();
      continue;
    }
    if (s.startsWith('/*')) {
      const end = s.indexOf('*/');
      if (end === -1) return '';
      s = s.slice(end + 2).trimStart();
      continue;
    }
    break;
  }
  return (s.match(/^[a-z]+/i)?.[0] ?? '').toLowerCase();
}

/**
 * Transaction-keyword classification shared by both protocols.
 * `commit` covers END, `rollback` covers ABORT, `begin` covers
 * START TRANSACTION. ROLLBACK TO SAVEPOINT intentionally stays null —
 * the transaction stays open.
 */
function txnKeyword(sql: string): 'begin' | 'commit' | 'rollback' | null {
  const word = firstWord(sql);
  if (word === 'begin' || word === 'start') return 'begin';
  if (word === 'commit' || word === 'end') return 'commit';
  if (word === 'rollback' || word === 'abort') {
    // ROLLBACK TO SAVEPOINT keeps the transaction open.
    return /^rollback\s+to\b/i.test(sql.trim()) ? null : 'rollback';
  }
  return null;
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

function readyForQuery(status: 'I' | 'T' | 'E'): Buffer {
  return message('Z', Buffer.from(status, 'latin1'));
}

/** Postgres ErrorResponse with severity / SQLSTATE / message fields. */
function errorResponse(severity: string, code: string, text: string): Buffer {
  return message(
    'E',
    Buffer.concat([
      Buffer.from('S', 'latin1'),
      cstring(severity),
      Buffer.from('C', 'latin1'),
      cstring(code),
      Buffer.from('M', 'latin1'),
      cstring(text),
      Buffer.from([0]),
    ]),
  );
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

/** Statements that produce no rows (NoData on Describe, bare CommandComplete on Execute). */
function isRowless(sql: string): boolean {
  const lower = sql.trim().toLowerCase();
  if (lower.startsWith('set ')) return true;
  const word = firstWord(sql);
  return [
    'begin',
    'start',
    'commit',
    'end',
    'rollback',
    'abort',
    'savepoint',
    'release',
    'insert',
    'update',
    'delete',
  ].includes(word);
}

/** Command tag for a row-less statement, given the socket's pre-statement txn. */
function rowlessTag(sql: string, txn: 'I' | 'T' | 'E'): string {
  const lower = sql.trim().toLowerCase();
  if (lower.startsWith('set ')) return 'SET';
  const word = firstWord(sql);
  switch (word) {
    case 'begin':
    case 'start':
      return 'BEGIN';
    case 'commit':
    case 'end':
      return txn === 'E' ? 'ROLLBACK' : 'COMMIT';
    case 'rollback':
      return 'ROLLBACK';
    case 'abort':
      return 'ROLLBACK';
    case 'savepoint':
      return 'SAVEPOINT';
    case 'release':
      return 'RELEASE';
    case 'insert':
      return 'INSERT 0 1';
    default:
      return `${word.toUpperCase()} 1`;
  }
}

/** Answer to a portal Describe: one column, or NoData for row-less SQL. */
function describeAnswer(sql: string): Buffer {
  if (isRowless(sql)) {
    return message('n', Buffer.alloc(0));
  }
  return rowDescription(resultShape(sql).column);
}
