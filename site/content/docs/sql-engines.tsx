import { Callout } from '@/components/docs/callout';
import { DocTable } from '@/components/docs/doc-table';
import { Keys } from '@/components/docs/keys';
import { B, C, Doc, LI, P, UI, UL } from '@/components/docs/prose';
import type { DocPage } from './types';

export const mysql: DocPage = {
  slug: 'mysql-mariadb',
  title: 'MySQL and MariaDB',
  group: 'Engine guides',
  summary:
    'The SQL workbench for MySQL and MariaDB: connecting, what runs where, cancelling a query, read-only enforcement and the differences from PostgreSQL.',
  sections: [
    {
      id: 'connect',
      title: 'Connecting',
      body: (
        <>
          <P>
            Choose <UI>MySQL · MariaDB</UI>{' '}in <UI>Add a connection</UI>, or paste a <C>mysql://</C>{' '}or <C>mariadb://</C>{' '}URL.
            The defaults are port 3306 and user <C>root</C>; the database is optional. TLS (<UI>SSL mode</UI>), client
            certificates and SSH tunnels work as described under <Doc to="connections">Connections</Doc>. The server
            version shown is read from the server (for example <C>MySQL 8.4.0</C>{' '}or <C>MariaDB 11.4.2</C>).
          </P>
        </>
      ),
    },
    {
      id: 'features',
      title: 'What works',
      body: (
        <>
          <DocTable
            head={['Feature', 'MySQL / MariaDB']}
            rows={[
              ['SQL editor, results, history, snippets, notebooks, codegen', 'Yes'],
              ['Grid editing with conflict detection', 'Yes (text is compared with the column collation)'],
              ['Structure tab', 'Columns, keys, foreign keys, indexes and triggers; add column, rename column, rename table'],
              ['ER diagram', 'Yes'],
              ['EXPLAIN', 'Plain EXPLAIN (no ANALYZE)'],
              ['SSH tunnel, TLS', 'Yes'],
              ['Safe Run, Health, Roles, Import, Backup, Schema diff, Search in database', 'Not available (PostgreSQL only)'],
            ]}
          />
        </>
      ),
    },
    {
      id: 'behaviour',
      title: 'Behaviour to know',
      body: (
        <UL>
          <LI>
            <B>Two connections.</B>{' '}One runs your statements; a second runs lookups, AI read queries and{' '}
            <C>KILL QUERY</C>. <UI>Cancel</UI>{' '}sends <C>KILL QUERY</C>{' '}for the running thread.
          </LI>
          <LI>
            <B>Read-only is enforced by the session.</B>{' '}A read-only connection sets the session read-only before every
            statement and screens for statements that try to switch it off. AI and MCP queries run in a read-only
            transaction, and first have to look like a read, because MariaDB lets DDL through a read-only transaction.
          </LI>
          <LI>
            <B>DDL commits.</B>{' '}Statements such as <C>CREATE</C>{' '}and <C>ALTER</C>{' '}end the current transaction on MySQL, and
            Plasma treats them that way when it reports an open transaction.
          </LI>
          <LI>
            <B>Types.</B>{' '}Booleans come back as <C>1</C>{' '}and <C>0</C>. There is no time-zone-carrying timestamp type, so none is
            shown. MariaDB returns JSON as text.
          </LI>
          <LI>
            <B>Timeouts.</B>{' '}The query timeout in <UI>Settings</UI>{' '}&rarr; <UI>Security</UI>{' '}is mapped to the server&rsquo;s{' '}
            <C>max_execution_time</C>{' '}(MySQL) or <C>max_statement_time</C>{' '}(MariaDB), and a timed-out statement reads like the
            others.
          </LI>
        </UL>
      ),
    },
  ],
};

export const sqlite: DocPage = {
  slug: 'sqlite',
  title: 'SQLite',
  group: 'Engine guides',
  summary: 'Open any SQLite file, create a new one, query it, diagram it and copy it safely. No server, login or tunnel.',
  sections: [
    {
      id: 'open',
      title: 'Opening a file',
      body: (
        <>
          <P>
            Choose <UI>SQLite</UI>{' '}in <UI>Add a connection</UI>{' '}and use <UI>Open…</UI>{' '}to pick a file, or <UI>New…</UI>{' '}to create
            one. Or run <C>plasma open path/to/file.sqlite</C>{' '}from a terminal (see{' '}
            <Doc to="command-line">Command line</Doc>); Plasma checks that it is a SQLite database and fills the dialog.
            Turn on <UI>Read-only</UI>{' '}to open the file without being able to change it: Plasma then opens a read-only file
            handle and sets <C>query_only</C>.
          </P>
          <Callout kind="note" title="Plasma only opens files you chose">
            The main process allows a SQLite path only after you pick it in a dialog, pass it on the command line, or it
            belongs to a saved connection, so a web page or a stray link cannot make the app open an arbitrary file.
          </Callout>
        </>
      ),
    },
    {
      id: 'features',
      title: 'What works',
      body: (
        <>
          <DocTable
            head={['Feature', 'SQLite']}
            rows={[
              ['SQL editor, results, history, snippets, notebooks, codegen', 'Yes'],
              ['Grid editing with conflict detection', 'Yes'],
              ['Structure tab', 'Columns, keys, foreign keys, indexes and triggers; add column, rename column, rename table'],
              ['ER diagram', 'Yes'],
              ['EXPLAIN', 'Plain EXPLAIN'],
              ['Export database file copy…', 'Yes (command palette)'],
              ['Safe Run, Health, Import wizard, Schema diff, SSH', 'Not available'],
            ]}
          />
          <P>
            <UI>Export database file copy…</UI>{' '}writes a consistent copy of the open file with SQLite&rsquo;s backup API while the
            database stays open and writable. To load a CSV into a SQLite database, use SQL, or open the CSV with{' '}
            <Doc to="duckdb">DuckDB</Doc>.
          </P>
        </>
      ),
    },
    {
      id: 'notes',
      title: 'Notes',
      body: (
        <UL>
          <LI>
            SQLite has no boolean, array or decimal type. Booleans show as <C>1</C>{' '}and <C>0</C>, and <C>NUMERIC</C>{' '}is a binary
            float, so keep exact decimals in <C>TEXT</C>.
          </LI>
          <LI>
            <B>Cancel has limits.</B>{' '}SQLite offers no way to interrupt a running statement. Plasma checks for a cancel between
            rows, so a statement that produces no rows for a long time (a huge aggregate) cannot be stopped until it returns.
          </LI>
          <LI>
            AI and MCP queries run with <C>query_only</C>{' '}set, and <C>ATTACH</C>{' '}and <C>DETACH</C>{' '}are refused.
          </LI>
        </UL>
      ),
    },
  ],
};

export const clickhouse: DocPage = {
  slug: 'clickhouse',
  title: 'ClickHouse',
  group: 'Engine guides',
  summary: 'Query ClickHouse over HTTP(S) with a read-only grid, mutation warnings and a plan view.',
  sections: [
    {
      id: 'connect',
      title: 'Connecting',
      body: (
        <P>
          Choose <UI>ClickHouse</UI>{' '}or paste a <C>clickhouse://</C>{' '}URL. Plasma speaks HTTP: the default port is 8123, the
          default user and database are <C>default</C>, and the TLS selector is labelled <UI>HTTPS</UI>. SSH tunnels work.
          ClickHouse is stateless over HTTP, so a lost connection shows up as the next request failing rather than as a dropped
          session.
        </P>
      ),
    },
    {
      id: 'features',
      title: 'What works',
      body: (
        <>
          <DocTable
            head={['Feature', 'ClickHouse']}
            rows={[
              ['SQL editor, results, history, snippets, notebooks, codegen', 'Yes'],
              ['Grid editing', 'No. Results are read-only; change data with SQL.'],
              ['Structure tab', 'Viewer'],
              ['EXPLAIN', 'Plain EXPLAIN (no ANALYZE)'],
              ['ER diagram', 'No. ClickHouse has no foreign keys; its "primary key" is a sorting key.'],
              ['Safe Run, Health, Import, Roles, Schema diff', 'Not available'],
            ]}
          />
        </>
      ),
    },
    {
      id: 'mutations',
      title: 'Mutations are asynchronous',
      body: (
        <>
          <P>
            <C>ALTER TABLE … UPDATE</C>, <C>ALTER TABLE … DELETE</C>, <C>DELETE FROM</C>{' '}and <C>UPDATE … SET</C>{' '}do not change the
            data inside the statement. ClickHouse queues a background job that rewrites data parts; it cannot be rolled back and may
            take a long time on a large table. Before running one, Plasma shows <UI>Run an asynchronous mutation?</UI>{' '}with that
            explanation, and the statement returns before the change is complete. Check progress in <C>system.mutations</C>.
          </P>
        </>
      ),
    },
    {
      id: 'behaviour',
      title: 'Behaviour to know',
      body: (
        <UL>
          <LI>
            <B>Read-only</B>{' '}uses ClickHouse&rsquo;s own <C>readonly=1</C>{' '}setting, which the server refuses to lift. AI and MCP
            queries always use a separate client in that mode, even on a connection that is not read-only.
          </LI>
          <LI>
            <B>Cancel</B>{' '}aborts the HTTP request and sends <C>KILL QUERY</C>{' '}for it.
          </LI>
          <LI>
            <B>Values.</B>{' '}Arrays arrive as JSON arrays. A <C>String</C>{' '}column is not binary-safe through the JSON output
            Plasma reads.
          </LI>
        </UL>
      ),
    },
  ],
};

export const duckdb: DocPage = {
  slug: 'duckdb',
  title: 'DuckDB and data files',
  group: 'Engine guides',
  summary:
    'Query CSV, TSV, Parquet, JSON, NDJSON and Excel files, or a .duckdb database, with SQL. Join them with a live PostgreSQL database if you like.',
  sections: [
    {
      id: 'open',
      title: 'Opening files',
      body: (
        <>
          <P>
            Use <UI>Open data file…</UI>{' '}on the Connections home, in the File menu, or in the palette, or drop files on the
            window. The Connections home says: &ldquo;Drop a CSV, Excel, Parquet or JSON file here, or open one. DuckDB makes
            each file (and each Excel sheet) a table you can query with SQL.&rdquo; Opening files starts a new DuckDB session and
            disconnects the current connection; when you drop files onto a window that is connected elsewhere, Plasma asks{' '}
            <UI>Open these files in DuckDB?</UI>{' '}first.
          </P>
          <DocTable
            head={['Kind', 'Extensions']}
            rows={[
              ['CSV', '.csv (also .csv.gz); .txt is not accepted here'],
              ['TSV', '.tsv, .tab (also gzipped)'],
              ['Parquet', '.parquet'],
              ['JSON', '.json (also gzipped)'],
              ['NDJSON', '.ndjson, .jsonl (also gzipped)'],
              ['Excel', '.xlsx. Old .xls workbooks are not supported; save as .xlsx first.'],
              ['DuckDB database', '.duckdb, .ddb. Opened read-only.'],
            ]}
          />
          <UL>
            <LI>
              Each file becomes a view named after the file (spaces and symbols become underscores; clashes get <C>_2</C>,{' '}
              <C>_3</C>). An Excel workbook gives one view per visible sheet, named <C>file_sheet</C>.
            </LI>
            <LI>
              File names containing <C>*</C>, <C>?</C>, <C>[</C>{' '}or <C>]</C>{' '}are refused, because DuckDB would treat them as
              patterns.
            </LI>
            <LI>
              Plasma only reads files you chose with the picker or dropped on the window; the renderer cannot name a path on
              its own.
            </LI>
          </UL>
        </>
      ),
    },
    {
      id: 'query',
      title: 'Querying',
      body: (
        <>
          <P>
            The workbench is the SQL editor with DuckDB as the engine. The sidebar lists the views; the grid is read-only. In the
            Structure tab each view shows a column profile (type, null percentage, an approximate distinct count, minimum and
            maximum) produced by DuckDB&rsquo;s <C>SUMMARIZE</C>. Cancel interrupts the running statement. DuckDB has no plan
            view or ER diagram in Plasma.
          </P>
          <Callout kind="note" title="A one-time download for Excel and Postgres">
            DuckDB&rsquo;s official extensions are not bundled. The first time you open an Excel file, or attach PostgreSQL,
            Plasma asks before it downloads the signed extension from extensions.duckdb.org (about 12 MB for Excel and about 40
            MB for Postgres, as the prompt says). Decline and the file is not opened. Nothing is downloaded without your agreement.
          </Callout>
        </>
      ),
    },
    {
      id: 'attach',
      title: 'Attach a PostgreSQL connection',
      body: (
        <P>
          <UI>Attach a Postgres connection to this DuckDB session…</UI>{' '}(palette, while a file session is open) lists your saved
          PostgreSQL connections. The chosen one is attached <B>read-only</B>{' '}under the alias <C>pg_&lt;name&gt;</C>, so you can
          join your files with live tables. The session reopens with the same files. Queries run in DuckDB; nothing is written to
          PostgreSQL.
        </P>
      ),
    },
    {
      id: 'db-file',
      title: 'A .duckdb file as a connection',
      body: (
        <P>
          You can also save a connection of engine <UI>DuckDB</UI>{' '}with <UI>DuckDB file</UI>{' '}pointing at a <C>.duckdb</C>{' '}file.
          It opens read-only. For CSV, Excel, Parquet or JSON, use <UI>Open data file…</UI>{' '}instead; the form says so. A read-only
          transaction is used for AI queries, which also refuses <C>nextval()</C>.
        </P>
      ),
    },
  ],
};
