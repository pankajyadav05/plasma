import { Callout } from '@/components/docs/callout';
import { DocTable } from '@/components/docs/doc-table';
import { Shot } from '@/components/docs/figure';
import { Keys } from '@/components/docs/keys';
import { B, C, Doc, LI, P, UI, UL } from '@/components/docs/prose';
import type { DocPage } from './types';

export const schemaTools: DocPage = {
  slug: 'schema-tools',
  title: 'Schema tools',
  group: 'Working with data',
  summary:
    'Change structure with a reviewable plan, draw the schema, diff two versions, check a migration for unsafe locks, manage roles, generate code and mock data, import files, back up, and search every table for a value.',
  sections: [
    {
      id: 'availability',
      title: 'Which engine gets what',
      body: (
        <>
          <P>
            Most of these tools are built for PostgreSQL. The table shows where each one is offered; a tool that does not
            apply to the connected engine is also hidden from the command palette.
          </P>
          <DocTable
            head={['Tool', 'PostgreSQL', 'MySQL / MariaDB', 'SQLite', 'ClickHouse', 'DuckDB']}
            rows={[
              ['Structure editor (staged changes)', 'Yes', 'Add column, rename', 'Add column, rename', 'View', 'View'],
              ['ER diagram', 'Yes', 'Yes', 'Yes', '', ''],
              ['Schema diff, Check migration, Search in database', 'Yes', '', '', '', ''],
              ['Roles and privileges', 'Yes', '', '', '', ''],
              ['Import data wizard', 'Yes', '', '', '', ''],
              ['Back up / Restore', 'Yes (pg_dump)', '', 'File copy', '', ''],
              ['Codegen, Notebook', 'Yes', 'Yes', 'Yes', 'Yes', 'Yes'],
            ]}
          />
        </>
      ),
    },
    {
      id: 'structure',
      title: 'Structure editor',
      body: (
        <>
          <Shot k="pg-structure" caption="The Structure view with one staged change and the Preview SQL panel." />
          <P>
            Open a table and switch the footer to <UI>Structure</UI>. On PostgreSQL the columns, constraints and indexes are
            editable in place. Nothing runs as you type: each change is staged, and the generated SQL is shown by{' '}
            <UI>Preview SQL</UI>.
          </P>
          <UL>
            <LI>
              <B>Columns:</B>{' '}rename, change the type (with an optional <UI>USING</UI>{' '}expression for the conversion), toggle
              nullable, set a default or a comment, mark a column to drop (<UI>Drop column</UI>, undo with{' '}
              <UI>Keep column</UI>), or add one with <UI>+ Column</UI>.
            </LI>
            <LI>
              <B>Indexes:</B> <UI>+ Index</UI>{' '}asks for an optional name, the columns (order matters), the method and an optional
              partial-index <C>WHERE</C>; existing indexes can be dropped. An index that backs a constraint says to drop the
              constraint instead.
            </LI>
            <LI>
              <B>Constraints:</B> <UI>+ Constraint</UI>{' '}adds Unique, Check or Foreign key (with the referenced table and
              columns and the update and delete actions).
            </LI>
          </UL>
          <P>
            <UI>Apply</UI>{' '}runs the plan; <UI>Discard</UI>{' '}drops it. Everything runs in one transaction, except statements that
            Postgres only allows on their own (<C>CREATE INDEX CONCURRENTLY</C>), which run separately. The usual guards still
            apply: a read-only connection refuses, and Prod or Safe mode shows a confirmation with the exact SQL. The plan is
            also run through the <Doc to="schema-tools#migration-check">migration check</Doc>{' '}before you can apply it.
          </P>
          <P>
            On a table, the sidebar&rsquo;s <UI>New table, view or import</UI>{' '}button opens <UI>New table</UI>{' '}(columns with type,
            primary key, not null and default, plus a live SQL preview) and <UI>New view</UI>{' '}(a view or a materialized view
            from a query).
          </P>
          <P>
            On MySQL/MariaDB and SQLite the Structure view lists columns, keys, foreign keys, indexes and triggers and offers{' '}
            <UI>Add column</UI>{' '}and rename for columns and the table. On ClickHouse and DuckDB it is a viewer; DuckDB also shows
            a per-column profile (null %, approximate distinct count, min and max).
          </P>
        </>
      ),
    },
    {
      id: 'object-actions',
      title: 'Sidebar object actions',
      body: (
        <P>
          Right-click an object in the Items sidebar for <UI>Open</UI>, <UI>Open in new tab</UI>, <UI>Open structure</UI>,{' '}
          <UI>Show diagram</UI>, <UI>Copy name</UI>, <UI>Copy qualified name</UI>, and <UI>Copy script as</UI> <C>CREATE</C>,{' '}
          <C>SELECT</C>, <C>INSERT</C>, <C>TRUNCATE</C>{' '}or <C>DROP</C>. <UI>Truncate…</UI>{' '}and <UI>Drop…</UI>{' '}show the exact
          statement and a <UI>Cascade to dependent objects</UI>{' '}option first, and then run through the normal query path, so
          Prod gates, Safe mode and read-only apply. <UI>Import…</UI>, <UI>Export as CSV…</UI>{' '}and <UI>Export as JSON…</UI>{' '}
          are there too.
        </P>
      ),
    },
    {
      id: 'er',
      title: 'ER diagram',
      body: (
        <>
          <Shot k="pg-er" caption="The ER diagram of a schema, with foreign-key relationships." />
          <P>
            <UI>Show diagram</UI>{' '}(palette, Database menu, or the sidebar) draws the tables of a schema as boxes joined by
            their foreign keys. It uses the active table&rsquo;s schema, or <C>public</C>. Drag tables to arrange them, zoom
            in and out, <UI>Fit to screen</UI>{' '}and <UI>Reset layout</UI>. <UI>Find table or column</UI>{' '}filters the diagram. The
            options menu chooses how much of each table to draw: <UI>All columns</UI>, <UI>Keys only</UI>{' '}or <UI>Names only</UI>.
            Click a table to open it. <UI>Export diagram</UI>{' '}saves a PNG or SVG image.
          </P>
          <P>
            It is built from the foreign keys Plasma reads from the database, on PostgreSQL, MySQL/MariaDB and SQLite. ClickHouse
            has no foreign keys and DuckDB has no diagram.
          </P>
        </>
      ),
    },
    {
      id: 'schema-diff',
      title: 'Schema diff',
      body: (
        <>
          <P>
            <UI>Schema diff…</UI>{' '}(<Keys k="mod+shift+d" />, PostgreSQL) compares two versions of a schema and writes the
            migration that turns the first into the second. Choose a left and a right side from your <B>snapshots</B>{' '}and the{' '}
            <B>live schema</B>. <UI>Take snapshot</UI>{' '}(with an optional name) saves the current structure locally; Plasma keeps
            the newest 50. A typical use: snapshot, make changes, diff the snapshot against live.
          </P>
          <UL>
            <LI>
              The diff covers added, dropped and kind-changed relations (table to view and so on) and, for tables, added and
              dropped columns and changes of type and nullability. Every statement uses the right verb for the kind (<C>DROP VIEW</C>,
              not <C>DROP TABLE</C>).
            </LI>
            <LI>
              Snapshots do not store view bodies, partition bounds, CHECK or UNIQUE constraints or grants. For those, the script
              says what to copy over instead of inventing SQL.
            </LI>
            <LI>
              <UI>Copy migration</UI>{' '}copies the script. Review it, and run it through{' '}
              <Doc to="schema-tools#migration-check">migration check</Doc>.
            </LI>
          </UL>
        </>
      ),
    },
    {
      id: 'migration-check',
      title: 'Migration check',
      body: (
        <>
          <P>
            DDL can lock a production table for minutes. <UI>Check migration…</UI>{' '}(PostgreSQL) looks at the whole script in the
            editor, <B>without running it</B>, and reports two things: lint findings and the table locks each statement takes.
            The same panel appears above every <UI>Preview SQL</UI>{' '}(structure edits, roles, import scripts) and as squiggles in
            the editor.
          </P>
        </>
      ),
      subs: [
        {
          id: 'lint-rules',
          title: 'What it flags',
          body: (
            <>
              <P>Each finding has a severity (error, warning or info), the reason, and a safer alternative. The rules are:</P>
              <DocTable
                head={['Severity', 'Rule']}
                rows={[
                  ['Error', 'CREATE INDEX without CONCURRENTLY'],
                  ['Error', 'Unique index / constraint built while blocking writes'],
                  ['Error', 'ADD COLUMN forces a table rewrite'],
                  ['Error', 'ADD COLUMN … NOT NULL without a default'],
                  ['Error', 'ALTER COLUMN TYPE rewrites the table'],
                  ['Error', 'ADD FOREIGN KEY without NOT VALID'],
                  ['Error', 'ADD CONSTRAINT CHECK without NOT VALID'],
                  ['Error', 'VACUUM FULL / CLUSTER rewrites the table'],
                  ['Error', 'Changing a primary key'],
                  ['Error', 'CONCURRENTLY inside a transaction block'],
                  ['Warning', 'DROP INDEX without CONCURRENTLY'],
                  ['Warning', 'SET NOT NULL scans the whole table'],
                  ['Warning', 'Foreign key columns have no index'],
                  ['Warning', 'RENAME COLUMN / RENAME TABLE breaks running applications'],
                  ['Warning', 'DROP COLUMN / DROP TABLE is destructive'],
                  ['Warning', 'TRUNCATE removes all rows'],
                  ['Info', 'No lock_timeout set'],
                ]}
              />
              <P>
                Some findings carry a one-click fix such as <UI>Add CONCURRENTLY</UI>, <UI>Add NOT VALID</UI>{' '}or a{' '}
                <C>SET lock_timeout</C>{' '}line. Where a panel guards an action (applying a structure change, for example), error
                findings must be acknowledged with <UI>Run anyway. I understand the risks listed above.</UI>{' '}before the button
                enables. In <UI>Settings</UI>{' '}&rarr; <UI>Editor</UI>{' '}you can turn the linter off, show only warnings and errors
                or only errors, and untick individual rules to mute them everywhere.
              </P>
            </>
          ),
        },
        {
          id: 'locks',
          title: 'Lock preview',
          body: (
            <P>
              For each statement the panel names the table lock it takes, from <C>ACCESS SHARE</C>{' '}up to{' '}
              <C>ACCESS EXCLUSIVE</C>, and what that lock blocks (nothing, writes, or reads and writes). It also reads the live
              database for the affected table &mdash; estimated rows, size, and the sessions that are using it now, with their
              pid, user, state and query &mdash; so you can see who you would be waiting for. Refresh the context with the
              refresh button.
            </P>
          ),
        },
      ],
    },
    {
      id: 'roles',
      title: 'Roles and privileges',
      body: (
        <>
          <Shot k="pg-roles" caption="The Roles and privileges dialog, Table privileges tab." />
          <P>
            <UI>Roles and privileges…</UI>{' '}(PostgreSQL) lists the server&rsquo;s roles. Select one to edit it, or use the{' '}
            <UI>New role</UI>{' '}button. A role has a <UI>Name</UI>, a <UI>Password</UI>{' '}(blank keeps the current one), and
            attributes: <UI>Can log in</UI>, <UI>Superuser</UI>, <UI>Can create databases</UI>, <UI>Can create roles</UI>,{' '}
            <UI>Inherits privileges of member roles</UI>, <UI>Replication</UI>{' '}and <UI>Bypass row-level security</UI>; a connection
            limit (<C>-1</C>{' '}is no limit), a <UI>Valid until</UI>{' '}date, and the roles it is a member of (with the reverse list
            of its members).
          </P>
          <P>
            The <UI>Table privileges</UI>{' '}tab shows a grid of checkboxes per table and privilege. It shows direct grants only
            and the first 1,500 tables; narrow it with the schema selector and the table filter. Everything is staged:{' '}
            <UI>Preview SQL</UI>{' '}shows the statements, the migration check runs on them, and <UI>Apply</UI>{' '}executes them
            (<UI>Drop role</UI>{' '}for a deletion). On a read-only connection the dialog is view-only.
          </P>
          <P>
            Separately, the right sidebar&rsquo;s <UI>Session role</UI>{' '}panel shows and sets the role the current session runs
            as (<C>SET ROLE</C>), and <UI>Row-level security</UI>{' '}lists a table&rsquo;s policies.
          </P>
        </>
      ),
    },
    {
      id: 'codegen',
      title: 'Code generation',
      body: (
        <P>
          <UI>Generate code…</UI>{' '}(<Keys k="mod+shift+g" />) turns the tables of the connected database into code. Pick tables
          with the filter and checkboxes, then a target: <UI>TypeScript interfaces</UI>, <UI>Zod schemas</UI>,{' '}
          <UI>Prisma model</UI>, <UI>Drizzle (pg-core)</UI>, <UI>SQLAlchemy 2.0</UI>{' '}or <UI>CREATE TABLE (DDL)</UI>. Copy the
          result. It is generated on your machine from the schema Plasma has already read, and the type mapping is a simple one
          based on the column type names, so review it before you rely on it.
        </P>
      ),
    },
    {
      id: 'mock-data',
      title: 'Mock data',
      body: (
        <>
          <P>
            In a table tab with edit mode on, the footer&rsquo;s <UI>More</UI>{' '}menu has <UI>Generate mock rows…</UI>. Choose how
            many rows (1 to 5,000) and, per column, whether to include it and which generator to use: <C>auto</C>{' '}(picked from
            the column name and type), first, last or full name, email, URL, lorem ipsum, word, country code, random letters,
            integer, numeric, boolean, timestamp, date, UUID, JSON, a fixed value you type, or NULL. Values respect{' '}
            <C>char(n)</C>{' '}and <C>varchar(n)</C>{' '}lengths. Generation needs no extra library and nothing leaves your machine.
          </P>
          <P>
            The rows are inserted in batches inside one transaction; if any batch fails they all roll back. Like any write, it
            asks for confirmation on Prod connections and under a Safe mode that asks.
          </P>
        </>
      ),
    },
    {
      id: 'import',
      title: 'Import data',
      body: (
        <>
          <Shot k="pg-import" caption="Import into an existing table: the file preview and column mapping." />
          <P>
            <UI>Import</UI>{' '}(PostgreSQL) reads <B>CSV, TSV, JSON</B>{' '}(an array of objects), <B>NDJSON</B>{' '}or a <B>.sql script</B>.
            Open it from a table&rsquo;s menu, from <UI>New table, view or import</UI>, or from the terminal with{' '}
            <Doc to="command-line#import">plasma import</Doc>.
          </P>
          <UL>
            <LI>
              Choose a file; Plasma previews the first part of it (the first 8 rows are shown). For CSV you can set the{' '}
              <UI>Delimiter</UI>, the <UI>Quote character</UI>{' '}and the <UI>NULL string</UI>{' '}(empty means empty cells).
            </LI>
            <LI>
              <UI>Existing table</UI>{' '}maps each file column to a target column (or skips it). <UI>New table</UI>{' '}creates one, with
              a name and a type for each column, inferred from the data and editable.
            </LI>
            <LI>
              The import runs in <B>one transaction</B>: any error rolls everything back. It streams the file, so large files do
              not have to fit in memory, and shows rows read and rows inserted as it goes. <UI>Cancel</UI>{' '}before it ends and
              nothing is imported.
            </LI>
            <LI>
              A .sql script shows its first statements and goes through the migration check.
            </LI>
            <LI>
              Import is refused on a read-only connection, and the SQL it runs is recorded in the audit log when auditing
              applies to the connection.
            </LI>
          </UL>
        </>
      ),
    },
    {
      id: 'backup',
      title: 'Backup and restore',
      body: (
        <>
          <P>
            PostgreSQL backups use the standard tools, so they must be installed on your computer: <C>pg_dump</C>,{' '}
            <C>pg_restore</C>{' '}and <C>psql</C>. Plasma looks on your <C>PATH</C>{' '}and in the usual install folders
            (Homebrew, Postgres.app, the PostgreSQL folders on Windows and Linux), or in the folder you set under{' '}
            <UI>Settings</UI>{' '}&rarr; <UI>Advanced</UI>{' '}&rarr; <UI>PostgreSQL tools</UI>. It warns with a{' '}
            <UI>Version mismatch</UI>{' '}badge when the tool is older than the server. The password is passed to the tool through
            the environment, not on the command line.
          </P>
        </>
      ),
      subs: [
        {
          id: 'backup-dialog',
          title: 'Back up database…',
          body: (
            <UL>
              <LI>
                <UI>Objects:</UI>{' '}everything, selected schemas, or selected tables.
              </LI>
              <LI>
                <UI>Format:</UI>{' '}Custom (<C>.dump</C>), Plain SQL, Directory or Tar. <UI>Contents:</UI>{' '}schema and data, schema
                only, or data only.
              </LI>
              <LI>
                Options: no owner, no privileges, gzip compression (Plain SQL only), parallel jobs (Directory only). Then choose where to save and run it; the
                log shows the exact command and its output.
              </LI>
            </UL>
          ),
        },
        {
          id: 'restore-dialog',
          title: 'Restore database…',
          body: (
            <P>
              Choose a backup file (or folder), its type (an archive restored with <C>pg_restore</C>, or a SQL script, optionally
              gzipped, run with <C>psql</C>) and the target database, which must already exist. Options: <UI>Clean: drop
              objects before recreating them</UI>, <UI>Use IF EXISTS when dropping</UI>, <UI>No owner</UI>{' '}and{' '}
              <UI>Single transaction (all or nothing)</UI>, plus parallel jobs. Restore is refused on a read-only connection.
            </P>
          ),
        },
        {
          id: 'sqlite-backup',
          title: 'SQLite: Export database file copy…',
          body: (
            <P>
              Writes a consistent copy of the open SQLite file to a new file using SQLite&rsquo;s backup API. The database stays
              open and writable while it is copied.
            </P>
          ),
        },
      ],
    },
    {
      id: 'db-search',
      title: 'Search in database',
      body: (
        <>
          <Shot k="pg-search" caption="Search in database: matches grouped by table." />
          <P>
            <UI>Search in database…</UI>{' '}(PostgreSQL) finds a value in every table. Type the text or number, then choose how
            to match: <UI>contains</UI>, <UI>equals</UI>, <UI>starts with</UI>{' '}or <UI>matches regex</UI>, with an optional{' '}
            <UI>Match case</UI>. Narrow it by schema and a table-name filter, set the rows per table (default 50, at most 1,000),
            and tick the column classes to search: text, numbers and UUIDs by default, and optionally dates, booleans and JSON. Results are grouped by table with the matches highlighted; <UI>Open in table</UI>{' '}jumps to the rows.
          </P>
          <UL>
            <LI>
              It runs one read-only <C>SELECT</C>{' '}per table on a side connection, each with a 10-second limit, so a slow table
              does not hold up the rest. The term is sent as a bind parameter.
            </LI>
            <LI>The dialog shows up to 100 rows per table.</LI>
          </UL>
        </>
      ),
    },
    {
      id: 'data-files',
      title: 'Data files',
      body: (
        <P>
          Local CSV, Excel, Parquet and JSON files are queried with DuckDB through <UI>Open data file…</UI>. That workflow, and
          attaching a Postgres database next to your files, has its own page: <Doc to="duckdb">DuckDB and data files</Doc>.
        </P>
      ),
    },
  ],
};
