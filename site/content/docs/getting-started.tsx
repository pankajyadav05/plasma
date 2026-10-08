import { Callout } from '@/components/docs/callout';
import { DocTable } from '@/components/docs/doc-table';
import { Shot } from '@/components/docs/figure';
import { Keys } from '@/components/docs/keys';
import { B, C, Doc, LI, P, UI, UL } from '@/components/docs/prose';
import { Steps } from '@/components/docs/steps';
import type { DocPage } from './types';

export const gettingStarted: DocPage = {
  slug: 'getting-started',
  title: 'First connection and the workbench',
  group: 'Getting started',
  summary:
    'Connect to your first database, then learn where everything is: the sidebar, the tabs, the editor, the grid and the panels on the right.',
  sections: [
    {
      id: 'first-connection',
      title: 'Your first connection',
      body: (
        <>
          <P>
            When Plasma has no connection open it shows the <UI>Connections</UI>{' '}home. Until you save one it says{' '}
            <UI>No saved connections yet</UI>. Click <UI>New connection</UI>{' '}to start.
          </P>
          <Steps
            items={[
              {
                title: 'Paste a URL, or pick an engine',
                body: (
                  <>
                    <P>
                      The first screen is <UI>Add a connection</UI>. Either paste a connection URL into{' '}
                      <UI>Paste a connection URL</UI>, or choose one of the seven engines: PostgreSQL, MySQL &middot;
                      MariaDB, SQLite, ClickHouse, DuckDB, Redis or OpenSearch. Each card shows its default port (or
                      &ldquo;Local file&rdquo;). Arrow keys move between the cards and Enter chooses one.
                    </P>
                  </>
                ),
              },
              {
                title: 'Fill in the form',
                body: (
                  <P>
                    The form has cards for Connection, Server, Authentication, Security, SSH tunnel and Advanced; a
                    list on the side jumps to each one and marks it complete or in error. SQLite and DuckDB only have
                    Connection, Server and Advanced because a file has no network, login or tunnel. Every field is
                    described on <Doc to="connections">the Connections page</Doc>.
                  </P>
                ),
              },
              {
                title: 'Test it',
                body: (
                  <P>
                    <UI>Test</UI>{' '}walks through the connection one step at a time (find the host, reach the port, TLS,
                    log in, open the database) and stops at the first step that fails. A failure is explained in plain
                    words with the likely fix.
                  </P>
                ),
              },
              {
                title: 'Connect or save',
                body: (
                  <P>
                    <UI>Connect</UI>{' '}saves and connects (<Keys k="mod+Enter" />). <UI>Save</UI>{' '}keeps the connection
                    without connecting.
                  </P>
                ),
              },
            ]}
          />
          <Shot k="connection-dialog" caption="The New connection dialog." />
          <Callout kind="tip" title="Skip the form">
            To open a SQLite file, run <C>plasma open path/to/file.sqlite</C>{' '}from a terminal. To look at a CSV, Excel,
            Parquet or JSON file, use <UI>Open data file…</UI>{' '}on the Connections home. See{' '}
            <Doc to="command-line">Command line and links</Doc>{' '}and <Doc to="duckdb">DuckDB</Doc>.
          </Callout>
        </>
      ),
    },
    {
      id: 'workbench',
      title: 'The workbench',
      body: (
        <>
          <Shot k="pg-workbench" caption="A Postgres table in the data grid with the Details panel open." />
          <P>The window is built from a few fixed parts.</P>
          <DocTable
            head={['Part', 'What it does']}
            rows={[
              [
                'Icon rail',
                <>
                  Far left. The database tile (tables and queries), <UI>History</UI>{' '}(SQL engines), <UI>Health</UI>{' '}
                  (Postgres, Redis and OpenSearch) and <UI>Settings</UI>.
                </>,
              ],
              [
                'Top bar',
                <>
                  Hide or show the left sidebar; the lock button that turns edit mode on and off; the connection
                  switcher; <UI>New SQL query</UI>; reload; presentation mode; <UI>Open anything</UI>{' '}(the command
                  palette); the right sidebar. The connection capsule shows the engine, server, database and schema,
                  and its colour shows the status.
                </>,
              ],
              [
                'Left sidebar',
                <>
                  Three modes: <UI>Items</UI>{' '}(tables, views and other objects), <UI>Queries</UI>{' '}(saved queries and
                  snippets) and <UI>History</UI>. Redis and OpenSearch replace it with a key tree and an index list.
                </>,
              ],
              ['Tab strip', 'One tab per table or SQL script. Close, rename, duplicate and split from the tab menu.'],
              ['Editor and results', 'The SQL editor on top and the result grid below it, with a footer for paging, export and view switches.'],
              [
                'Right sidebar',
                <>
                  <UI>Details</UI>{' '}shows the selected row as a form. <UI>Assistant</UI>{' '}is the AI panel. A menu next to
                  them holds Compiled SQL, Session role and Row-level security for Postgres.
                </>,
              ],
            ]}
          />
        </>
      ),
      subs: [
        {
          id: 'edit-mode',
          title: 'Edit mode: the lock button',
          body: (
            <>
              <P>
                A fresh connection opens read-only for safety. The lock button in the top bar reads{' '}
                <UI>Safe mode &mdash; read only. Click to allow edits.</UI>{' '}Click it and the pencil appears:{' '}
                <UI>Edit mode &mdash; writes enabled. Click to lock.</UI>{' '}Grid editing, row inserts and deletes,
                and the write actions of Redis and OpenSearch all need edit mode. SQL you type in the editor is not
                blocked by this button; it goes through <Doc to="safety-privacy#safe-mode">Safe mode</Doc>{' '}instead.
              </P>
              <P>
                On a connection saved as <B>Read-only</B>, the button is disabled and reads &ldquo;Read-only connection
                &mdash; writes are disabled&rdquo;. Engines whose rows cannot be edited in the grid (ClickHouse and
                DuckDB) show &ldquo;Rows are read-only for this engine &mdash; write SQL in the editor instead&rdquo;.
              </P>
            </>
          ),
        },
        {
          id: 'tabs',
          title: 'Tabs and split panes',
          body: (
            <>
              <P>
                Opening a table from the sidebar opens a <B>preview tab</B>, shown in italics. Single-click another
                table and it replaces the preview. Double-click the tab, or choose <UI>Keep open</UI>{' '}from its menu, to
                keep it. The tab menu also has <UI>Close</UI>, <UI>Close Others</UI>, <UI>Close to the Right</UI>,{' '}
                <UI>Close All</UI>, <UI>Duplicate</UI>, <UI>Rename…</UI>{' '}and <UI>Split Pane Right</UI>. A tab is
                marked while its query is queued, running or being cancelled, and after a run that failed or whose
                outcome is unknown.
              </P>
              <P>
                A split puts two tabs side by side. <UI>Next pane</UI>{' '}and <UI>Previous pane</UI>{' '}move focus between
                them (<Keys k="mod+alt+]" />{' '}and <Keys k="mod+alt+[" />), and the tab shortcuts work inside the focused
                pane.
              </P>
              <Shot k="pg-split" caption="Two tabs in split panes: a join query on the left, a table on the right." />
              <P>
                With <UI>Restore open SQL tabs</UI>{' '}on in <UI>Settings</UI>{' '}&rarr; <UI>General</UI>, your query tabs for
                each connection come back the next time you connect. See{' '}
                <Doc to="reliability#crash-recovery">Crash recovery</Doc>{' '}for what survives a crash.
              </P>
            </>
          ),
        },
        {
          id: 'palette',
          title: 'Open anything: the command palette',
          body: (
            <>
              <P>
                <Keys k="mod+k" />{' '}opens one search box over everything: tables, open tabs, saved queries, Redis keys,
                OpenSearch indices, saved connections and every command (run, export, back up, diagram, settings and so
                on). Its placeholder reads &ldquo;Search tables, tabs, saved queries, actions…&rdquo;. Commands that do not
                apply to the connected engine are hidden.
              </P>
              <Shot k="palette" caption="The command palette with sh typed." />
            </>
          ),
        },
        {
          id: 'other-engines',
          title: 'Redis and OpenSearch workbenches',
          body: (
            <>
              <P>
                Redis and OpenSearch have no tables and no SQL editor, so their workbench looks different: a key tree
                or index list in the sidebar, an <UI>Overview</UI>{' '}tab, and views for search, CLI, console and so on.
                They are described on <Doc to="redis">Redis</Doc>{' '}and <Doc to="opensearch">OpenSearch</Doc>.
              </P>
            </>
          ),
        },
      ],
    },
    {
      id: 'next',
      title: 'Where to go next',
      body: (
        <UL>
          <LI>
            <Doc to="sql-editor">SQL editor</Doc>: run statements, Safe Run, history, EXPLAIN, notebooks.
          </LI>
          <LI>
            <Doc to="results">Results and editing data</Doc>: filter, sort, edit cells and commit safely.
          </LI>
          <LI>
            <Doc to="safety-privacy">Safety and privacy</Doc>: what Plasma does to stop dangerous changes.
          </LI>
          <LI>
            <Doc to="shortcuts">Keyboard shortcuts</Doc>.
          </LI>
        </UL>
      ),
    },
  ],
};
