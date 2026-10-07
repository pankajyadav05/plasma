# Driver contract

What every engine driver in `src/workers/drivers/` must do, what it may leave
out, and the test that holds it to both. The executable form of this document is
the conformance suite in `src/workers/drivers/conformance/`; when the two
disagree the suite is right and this file is the bug.

Run it with `pnpm test:conformance`. The embedded engines (SQLite, DuckDB) run
everywhere; a server engine runs when its `PLASMA_LIVE_*` variable is set (see
[Running the suite](#running-the-suite)). CI runs all of them on every push and
pull request.

## Who is a driver

| Engine | Class | Interface | Session |
| --- | --- | --- | --- |
| PostgreSQL | `PostgresDriver` | `SqlEngineDriver` (structurally; plus Safe Run, import, DDL, LISTEN) | three `pg` connections: primary, control (cancel only), aux (lookups, AI, management) |
| MySQL, MariaDB | `MysqlDriver` | `SqlEngineDriver` | two `mysql2` connections: primary, aux (lookups, AI, `KILL QUERY`) |
| SQLite | `SqliteDriver` | `SqlEngineDriver` | one synchronous `better-sqlite3` connection |
| DuckDB | `DuckdbDriver` | `SqlEngineDriver` | one in-process connection (data files, or a `.duckdb` file read-only) |
| ClickHouse | `ClickhouseDriver` | `SqlEngineDriver` | HTTP, stateless: a user client and an always-`readonly=1` client |
| Redis | `RedisDriver` | its own surface (`command`, `scan`, `getKey`, `write`, ...) | one `ioredis` client per database, plus dedicated blocking / subscriber clients |
| OpenSearch | `OpenSearchDriver` | its own surface (`request`, `search`, `sql`, `overview`, ...) | HTTP client |

`SqlEngineDriver` (`sql-engine.ts`) is the slice the worker dispatches
SQL-workbench requests to. Postgres does not declare `implements`, but the
conformance suite types its sessions as `SqlEngineDriver`, so the compiler
holds it to the same shape.

Drivers run in the isolated `utilityProcess` worker. Nothing here may block
that process's event loop for long: a `cancel` request has to be heard.

## Connection

* `connect(config, statementTimeoutMs?)` resolves with a version string:
  `PostgreSQL 16.2 on ...` (the server's `version()`), `MySQL 8.4.0` /
  `MariaDB 11.4.2`, `ClickHouse 24.8.4.13`, plain `3.45.1` (SQLite),
  `1.1.3` (DuckDB), the Redis `redis_version`, the OpenSearch `version.number`.
  It rejects on any failure and leaves **no half-open session**: a failed
  `connect` closes whatever it had opened.
* `connect` on a driver that is already connected, or whose session was lost,
  **replaces** the session: the old one is torn down first, so its late socket
  events can never be mistaken for the new session dying. (The worker always
  disconnects first; the drivers do not rely on it.)
* `disconnect()` is idempotent and never throws. After it, `query` and friends
  reject (the driver is not connected); `connect` works again on the same
  instance.
* A wrong password is an error that does **not** contain the password.
* `setConnectionGen(n)` stamps the session; `commitEditBatch` refuses a batch
  made for another generation.
* Health: Postgres probes a connection that has been idle for a while with a
  hard-capped `SELECT 1` and reports the session lost when the server does not
  answer (`PostgresLivenessOptions`); MySQL and Redis learn from socket events;
  ClickHouse is stateless, so loss shows up as the next request failing;
  SQLite and DuckDB have no connection to lose.

## Introspection

`introspect(opts?)` resolves with a `SchemaInfo` (`shared/protocol.ts`):

* `schemas`: the schemas / databases that hold user objects. SQLite and
  DuckDB report `main`; MySQL and ClickHouse report the database name.
* `tables`: `{ schema, name, kind: table | view | matview | foreign |
  partitioned, rowCountEstimate }`. Views are `view`, not `table`.
* `columns`: in table order, `ordinal` strictly increasing within a table,
  `dataType` never empty, `isNullable`, `hasDefault`, and `isPrimaryKey` for
  every column of the primary key (composite keys flag each column).
* `foreignKeys`: one row per column pair, rows of a composite key share the
  `constraint` name.
* `{ objects: true, columns: false }` returns the object list with an empty
  `columns` array and is cheap; it is the call the sidebar makes first.
* Hidden system schemas (`information_schema`, `pg_catalog`, `system`, ...)
  are not listed.

Not available: ClickHouse has no foreign keys and its "primary key" is a
sorting key; Redis and OpenSearch have no tables (Redis introspects through
`scan` and `refreshOverview`, OpenSearch through `overview` and `mapping`).

## Queries and values

`query(sql, params?, opts?)` runs **one statement** and resolves with a
`QueryResult`: `columns` (name, `dataTypeID`, `dataTypeName`), `rows` (arrays),
`rowCount`, `durationMs`, `command` (`SELECT`, `INSERT`, ...), `truncated`,
`txnState`. For a statement that returns no rows, `rowCount` is the number of
rows it affected.

The renderer splits a script into statements (`shared/sql-split`) and runs them
one by one; the SQLite, MySQL, ClickHouse and DuckDB drivers also accept a
script and answer with the last statement, and Postgres refuses one (its
cursor protocol allows a single command). Nothing may rely on either.

Parameters are written `$1, $2, ...` by every caller. Drivers other than
Postgres translate them (`translatePlaceholders`; ClickHouse inlines escaped
literals because the HTTP interface binds typed parameters only).

### What the grid receives

Rows go over IPC as JSON, so a cell is a JSON value. The rules are the same
for every engine; where an engine's own type has no exact JSON form the cell is
the engine's own text:

| Type | Cell | Notes |
| --- | --- | --- |
| integers | a JS number when it is a safe integer, otherwise the exact decimal text | A driver may return text for a safe integer; it may never return a number that is not exact. `9007199254740993` is always `"9007199254740993"`. |
| `NUMERIC` / `DECIMAL` | exact decimal text, scale kept (`12.30` stays `12.30`) | SQLite has no decimal type: `NUMERIC` is a binary float there, and exact decimals belong in `TEXT`. |
| `FLOAT` / `DOUBLE` | a JS number holding the shortest value that round-trips (`1.1`, not `1.100000023841858`) | |
| boolean | `true` / `false` | MySQL, MariaDB and SQLite have no boolean type and return `1` / `0`. |
| text | a string, unchanged: Unicode, emoji, quotes, backslashes, the empty string | `''` and `NULL` are different cells. |
| `NULL` | `null` | |
| `DATE`, `TIME`, `TIMESTAMP` | the server's text (`2024-02-29`, `2024-01-02 03:04:05.123456`), never a JS `Date` | No time zone is added or removed. |
| `TIMESTAMPTZ` | the server's text with its offset (`2024-01-02 06:34:05+05:30`) | The offset follows the session time zone; the instant is what is preserved. MySQL has no zone-carrying type. |
| `UUID` | the canonical lower-case text | |
| JSON / JSONB | a parsed value, **or** its JSON text (SQLite, DuckDB, MariaDB); consumers accept both | Postgres parses `json` / `jsonb` and keeps integers beyond 2^53 as exact text. |
| binary (`bytea`, `BLOB`) | `\x` + lower-case hex text | DuckDB's own `\xDE\xAD` escapes are converted. ClickHouse `String` is not binary-safe through JSON output. |
| arrays | Postgres: the array text (`{1,2,3}`); DuckDB, ClickHouse: a JSON array | SQLite and MySQL have no array type. |

OpenSearch documents are JSON already: `_source` is passed through, except that
an integer beyond 2^53 arrives as its exact digits in a string (and is sent
back exactly: a request body is forwarded as typed, never re-serialised).
Redis values are strings (`$binary` + base64 for bytes that are not UTF-8).

## Errors

A failing call rejects with an `Error` whose `message` names what the server
said. That is the whole shape the worker forwards:

```
{ kind: 'error', id, message, fatal?: 'connection-lost', txnLost?, notices? }
```

* Postgres errors also carry the `pg` fields (`code` = SQLSTATE, `position`,
  `detail`, `hint`) on the thrown object; the editor uses `position` for the
  squiggle. Other engines put the position in the message
  (`Syntax error: failed at position 1`).
* A SQL error must never look like a lost connection: `isConnectionLostError`
  is false for it, so nothing reconnects or retries.
* A failed statement leaves the session usable (Postgres inside a transaction
  moves it to `txnState: 'error'` until rolled back).
* Messages must not contain the password.

## Cancellation and timeouts

* `cancelQuery()` resolves `true` when it signalled a statement that was
  running and `false` when nothing was in flight (it never cancels the next
  statement by accident).
* The cancelled statement's promise rejects within 2 seconds with
  `canceling statement due to user request`, and the session is usable
  afterwards.
* The connect-time statement timeout stops a slow statement with
  `canceling statement due to statement timeout` (Postgres native text; the
  others normalise their server's message, MariaDB's `max_statement_time` and
  MySQL's `max_execution_time` included).

How each engine does it:

| Engine | Mechanism |
| --- | --- |
| Postgres | `pg_cancel_backend` from the dedicated control connection, bounded: an unanswered cancel marks the connection lost |
| MySQL, MariaDB | `KILL QUERY <thread>` from the aux connection |
| ClickHouse | the HTTP request is aborted and `KILL QUERY WHERE query_id = ...` is sent |
| DuckDB | `connection.interrupt()` |
| SQLite | a flag checked between rows. `better-sqlite3` exposes no interrupt, so a statement that produces no rows for a long time (a huge aggregate) cannot be stopped, and the worker cannot hear a cancel while it runs. Known gap. |
| Redis | `cancel()` unblocks a waiting `BLPOP` & co. with `CLIENT UNBLOCK`; the command then resolves with an empty reply (or rejects with "cancelled") |
| OpenSearch | `cancel(requestId)` aborts the HTTP request (it rejects with `request cancelled`) and cancels the matching server task |

## Read-only

* A connection opened with `readOnly: true` refuses `INSERT`, `UPDATE`,
  `DELETE`, DDL and every other write, **and cannot be flipped back** by the
  user's own SQL. The server enforces it where the engine allows it:
  Postgres `default_transaction_read_only` re-asserted before every
  statement (with a transaction check and a text screen for the obvious
  switches), MySQL `SET SESSION TRANSACTION READ ONLY` re-asserted before every
  statement and a screen for `READ WRITE` / `tx_read_only` / `PREPARE`,
  ClickHouse `readonly=1` (the server refuses to lift it), SQLite a read-only
  file handle plus `query_only`, DuckDB a read-only `.duckdb` file.
* `aiQuery(sql)` runs **one** read-only statement (several are refused) and
  refuses writes, including a write hidden in a function, procedure or CTE,
  whether or not the connection itself is read-only: Postgres runs it in
  `BEGIN READ ONLY` with a 30 s timeout; MySQL and MariaDB first check that the
  statement is a read (MariaDB lets DDL through a read-only transaction) and
  then run it in `START TRANSACTION READ ONLY`; SQLite sets `query_only` and
  refuses `ATTACH` / `DETACH`; DuckDB runs it in `BEGIN TRANSACTION READ
  ONLY` (so `nextval()` is refused too); ClickHouse uses the always-`readonly=1`
  client.
* `sidebandQuery(sql, params, { timeoutMs })` is the read-only lookup path
  (counts, autocomplete, activity) with the same rules and a timeout. Without
  `timeoutMs`, Postgres runs the statement on the aux session as a management
  operation that may write (the roles and health dialogs use it); no other
  engine has such a path.
* Redis: commands are classified (`shared/redis-command-policy.ts`); anything
  not known to be a read is a write, so scripts (`EVAL`), store variants
  (`SORT ... STORE`), TTL side effects (`GETEX`) and odd casing are all refused.
  OpenSearch: requests are classified (`shared/os-write-policy.ts`) the same
  way, SQL by its statement.
* The text screens are defence in depth, not the boundary: a name built at run
  time can never be caught by a screen, which is why the session itself is
  made read-only too. Residual, known: a stored procedure that itself starts a
  read-write transaction (MySQL) is not stopped by a read-only connection.

## Row editing

`commitEditBatch(generation, updates)` applies the grid's tray: statements the
renderer builds with `buildUpdateSql` / `buildInsertSql` / `buildDeleteSql`
(`renderer/lib/table-query.ts`) and the engine's dialect.

* All statements run in one transaction (`BEGIN ... COMMIT`), or in a
  `SAVEPOINT` when the user already has a transaction open, which is **never
  committed** by the tray.
* Every statement must report exactly one affected row. Zero ("the row changed
  or was deleted since it was loaded") and several ("the key is not unique")
  both roll the whole batch back; so does any database error. The message names
  the failing edit (`Edit 2 of 3 (...)`) and ends with `Nothing was saved.`
* Updating a column to the value it already has still counts as a match
  (MySQL is connected so that affected rows means matched rows).
* `NULL`s in non-key columns are set and cleared like any other value.
* Composite keys address one row; a table **without a key** is editable only
  where the dialect has a row locator: `ctid` (Postgres) or the implicit
  `rowid` (SQLite). MySQL, ClickHouse and DuckDB tables without a key are not
  editable.
* A batch for another connection generation is refused.

Engines without row edits say so when asked: ClickHouse (writes are
asynchronous mutations, so the grid does not edit; use `ALTER ... UPDATE`) and
DuckDB data-file sessions. Redis edits go through typed `write` operations,
OpenSearch through document requests.

## Result caps

`query` keeps at most `MAX_RESULT_ROWS` (10 000) rows and `MAX_RESULT_BYTES`
(32 MiB, raisable to the 256 MiB ceiling) of estimated payload, or the lower
`opts.maxRows` / `opts.maxBytes` the caller passes. Past a cap the driver stops
reading (MySQL kills the statement, ClickHouse drops the stream, a Postgres
cursor is closed), `rows` is a prefix, `rowCount` is the number of rows kept
(not a server total) and `truncated` is `true`. A result that exactly fits is
**not** truncated. An empty result keeps its `columns`.

`streamQueryForExport(sql)` is the uncapped path for file export: batches of
rows, the header even when the result is empty, no display cap.

Redis pages values (`getKey` with a cursor, 500 elements by default) and
refuses to fetch a string over 1 MiB (it returns its size and a preview).
OpenSearch refuses a response over `MAX_RESPONSE_BYTES` (64 MiB) instead of
buffering it, and reports the true hit total with `eq` / `gte`.

## Connection loss

A transport that dies (server killed, VPN dropped, laptop slept) is reported as
a **connection-lost error**, never as a generic failure and never by hanging:

* idle: the next call rejects at once with a `ConnectionLostError` and keeps
  doing so until `connect` runs again;
* mid-statement: the waiting call rejects instead of hanging. (MySQL used to
  leave it pending forever; the suite found it.)
* `isConnectionLostError(err)` (`shared/connection-loss.ts`) is true for it, so
  the worker tags the response `fatal: 'connection-lost'` and main reconnects
  and retries a read once. Writes are never replayed; if a transaction was open
  the response carries `txnLost` and the session says so.
* after the server is back, `connect` on the same driver works.

Embedded engines have no connection to lose.

## What each engine does not support, and why

The authoritative list is the `caps` of each fixture in
`conformance/fixtures/`; the suite prints every opt-out as a skipped test with
its reason. In short:

* **SQLite**: no exact decimals, no time-zone type, no arrays; no
  connection loss; a row-less statement cannot be cancelled.
* **DuckDB**: sessions are in-process data files, so no transactions
  (begin / commit / rollback answer `none`), no grid edits, no connection loss.
* **MySQL / MariaDB**: no time-zone-carrying timestamp, no arrays, no row
  locator, so key-less tables are not editable.
* **ClickHouse**: no transactions, constraints, foreign keys or grid edits (writes are
  asynchronous mutations); `JSON` is experimental and `String` is not
  binary-safe through JSON output.
* **Redis**: no schema, so no keys / relations / row edits / SQL scripts; no
  statement timeout (blocking commands carry their own deadline); no `aiQuery`
  (the agent uses the classified read-only commands); transactions
  (`MULTI`) are refused on the shared connection.
* **OpenSearch**: no schema, transactions or row edits; a request has a
  timeout, not a statement timeout.

## Running the suite

```
pnpm test:conformance          # embedded engines + whatever env is set
```

| Engine | Environment |
| --- | --- |
| Postgres | `PLASMA_LIVE_PG=postgres://user:pass@host:port/db` (makes and drops its own database) |
| MySQL | `PLASMA_LIVE_MYSQL=1` and `PLASMA_MYSQL_HOST/PORT/USER/PASSWORD` |
| MariaDB | `PLASMA_LIVE_MARIADB=1` and `PLASMA_MARIADB_HOST/PORT/USER/PASSWORD` |
| ClickHouse | `PLASMA_LIVE_CLICKHOUSE=1` and `PLASMA_CLICKHOUSE_HOST/PORT/USER/PASSWORD` (HTTP port) |
| Redis | `PLASMA_LIVE_REDIS=redis://host:port` (only keys under `plasma:conf:<pid>:` are touched; nothing is flushed) |
| OpenSearch | `PLASMA_LIVE_OS=http://host:port` (security disabled; makes and drops `plasma-conf-*` indices) |

Connection loss is exercised through a TCP proxy (`conformance/tcp-proxy.ts`)
that drops every socket and stops listening, then comes back on the same port.
It stands in for `kill -9` of the server, which a CI service container and a
shared local server cannot offer.

## Adding an engine, or a scenario

* A new engine adds a fixture under `conformance/fixtures/` (DDL, the handful of
  engine-specific statements, its type cases and its `caps`) and one
  `*.conformance.test.ts` file. It starts with every capability **on**; each
  one it turns off is `{ no: '<reason>' }`, and `capabilities.test.ts` rejects
  an opt-out without a reason or a missing flag.
* A new scenario goes into `sql-suite.ts` (or the Redis / OpenSearch suite),
  gated by a capability if some engine genuinely cannot do it. A scenario is
  never skipped silently: an `if (...) return` inside a test is a bug.
* A bug the suite finds is fixed in the driver with its own focused test next to
  the driver, and the contract above is updated if the behaviour is part of it.
