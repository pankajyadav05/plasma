import { Callout } from '@/components/docs/callout';
import { DocTable } from '@/components/docs/doc-table';
import { Keys } from '@/components/docs/keys';
import { B, C, Doc, LI, P, UI, UL } from '@/components/docs/prose';
import type { DocPage } from './types';

export const postgres: DocPage = {
  slug: 'postgres',
  title: 'PostgreSQL',
  group: 'Engine guides',
  summary:
    'PostgreSQL gets the full workbench. This page covers what is specific to it: the connection model, the Health advisor, live LISTEN/NOTIFY, row-level security, session roles, pgvector and PostGIS.',
  sections: [
    {
      id: 'overview',
      title: 'What you get',
      body: (
        <>
          <P>
            Everything in <Doc to="sql-editor">SQL editor</Doc>, <Doc to="results">Results</Doc>{' '}and{' '}
            <Doc to="schema-tools">Schema tools</Doc>{' '}works on PostgreSQL, and a few features exist only here: Safe Run, the
            structure editor, schema diff, migration check, roles, import, backup, search in database, LISTEN/NOTIFY and the
            Health advisor.
          </P>
          <P>
            Plasma opens three connections to the server: a primary one that runs your statements, a control connection used
            only to cancel them, and a side connection for lookups (row counts, autocomplete, activity, AI queries, search).
            This is why Cancel works while a long query holds the primary connection, and why the Health views never wait behind
            your own work.
          </P>
          <Callout kind="note" title="Setting up each session">
            In <UI>Advanced</UI>{' '}on the connection, <UI>Run after connecting (SQL)</UI>{' '}runs statements such as{' '}
            <C>SET search_path TO app, public;</C>{' '}every time the session connects. A statement that fails stops the connect.
            The <UI>Switch schema</UI>{' '}menu in the connection capsule chooses the schema the sidebar and the editor work in.
          </Callout>
        </>
      ),
    },
    {
      id: 'health',
      title: 'Health advisor',
      body: (
        <>
          <P>
            <UI>Health</UI>{' '}in the icon rail (also the toolbar button and <UI>Health advisor</UI>{' '}in the palette) runs read-only
            checks on the side connection and tells you what needs attention. <UI>Run all checks again</UI>{' '}refreshes it.
            The header strip shows tiles for the most important numbers, and a <UI>Needs attention</UI>{' '}list ranks the worst
            findings. Tabs:
          </P>
          <DocTable
            head={['Tab', 'What it checks']}
            rows={[
              ['Overview', 'Cache hit ratio; connections in use against the limit; long-running and idle-in-transaction sessions; replication slots (inactive or lagging, retaining WAL); standby lag; database sizes; the largest tables.'],
              ['Activity', 'Live sessions (below).'],
              ['Top queries', 'Statements from pg_stat_statements, sortable by total time, mean time or calls, with rows and cache hit %.'],
              ['Indexes', 'Unused indexes, duplicate and overlapping indexes, invalid indexes, tables mostly read by sequential scan, and foreign keys with no supporting index.'],
              ['Vacuum and bloat', 'Dead tuples and stale statistics, transaction-ID wraparound distance, autovacuum state (including when it is off or all workers are busy), and table and index bloat estimates.'],
            ]}
          />
          <P>
            Findings explain themselves with evidence. Where a fix is a single statement, a button shows the exact SQL with{' '}
            <UI>Copy</UI>, <UI>Open in editor</UI>{' '}and <UI>Run</UI>. Run goes through the same Prod gate and Safe mode as
            anything you type, and is disabled on a read-only connection. Top queries needs the{' '}
            <C>pg_stat_statements</C>{' '}extension; if it is not enabled the tab shows the steps and a <UI>Create extension</UI>{' '}
            button.
          </P>
        </>
      ),
      subs: [
        {
          id: 'activity',
          title: 'Activity: sessions and lock waits',
          body: (
            <>
              <P>
                The Activity tab lists sessions from <C>pg_stat_activity</C>{' '}(pid, state, user, database, wait event, who is
                blocking it, age, query), refreshed on a timer that you can pause. Filter by query, user, application or pid,
                by database, and with the <UI>Idle sessions</UI>{' '}and <UI>This monitor</UI>{' '}checkboxes. A <UI>Lock waits</UI>{' '}section shows
                what is blocked and by whom. Each row can <UI>Copy query</UI>, open the query in a new SQL tab, <UI>Cancel</UI>{' '}
                it (<C>pg_cancel_backend</C>: stops the query, keeps the connection) or <UI>Terminate</UI>{' '}it (
                <C>pg_terminate_backend</C>: closes the connection and rolls back its transaction). Both ask first. Plasma&rsquo;s
                own sessions cannot be cancelled from here.
              </P>
              <P>
                If your role is not allowed to see other users&rsquo; sessions, the tab says it needs <C>pg_monitor</C>.
              </P>
            </>
          ),
        },
      ],
    },
    {
      id: 'listen',
      title: 'Live tail: LISTEN / NOTIFY',
      body: (
        <>
          <P>
            <UI>Listen to notifications (LISTEN/NOTIFY)</UI>{' '}in the palette opens a live view. Type a channel name to start
            listening (up to 50 channels); each one has a stop button (<C>UNLISTEN</C>). Messages appear newest first with their
            channel, time and payload, capped at 2,000; if a flood is thinned, a line reports how many notifications were
            dropped.
          </P>
          <UL>
            <LI>
              <UI>Filter messages</UI>{' '}is a case-insensitive text filter. Prefix with <C>channel:</C>{' '}or <C>payload:</C>{' '}to
              search one field, or with <C>!</C>{' '}to exclude.
            </LI>
            <LI>
              <UI>Pause</UI>{' '}and <UI>Clear messages</UI>{' '}control the stream.
            </LI>
            <LI>
              <UI>Send a NOTIFY</UI>{' '}sends a message through <C>pg_notify</C>{' '}(the payload may be at most 7,999 bytes). Because
              it wakes every listener it counts as a write: a read-only connection refuses it, and it is recorded in the audit
              log with the source NOTIFY when auditing applies.
            </LI>
          </UL>
        </>
      ),
    },
    {
      id: 'rls-roles',
      title: 'Row-level security and session role',
      body: (
        <P>
          In the right sidebar, the <UI>Session tools</UI>{' '}menu (next to <UI>Details</UI>{' '}and <UI>Assistant</UI>) has{' '}
          <UI>Compiled SQL</UI>{' '}(the exact query behind the current table view), <UI>Session role</UI>{' '}and{' '}
          <UI>Row-level security</UI>. <UI>Session role</UI>{' '}shows and changes the role the session runs as with{' '}
          <C>SET ROLE</C>, which is how you see a table the way another user would. <UI>Row-level security</UI>{' '}lists the
          table&rsquo;s policies and shows how many there are. Managing roles themselves is in{' '}
          <Doc to="schema-tools#roles">Roles and privileges</Doc>.
        </P>
      ),
    },
    {
      id: 'pgvector',
      title: 'pgvector',
      body: (
        <P>
          When a result has a <C>vector</C>{' '}column, the footer&rsquo;s <UI>More</UI>{' '}menu offers <UI>Find similar (pgvector)</UI>.
          The dialog lists the vector columns with their dimensions and builds a nearest-neighbour query: choose the anchor
          column and the anchor row, a distance (cosine <C>&lt;=&gt;</C>, L2 <C>&lt;-&gt;</C>{' '}or inner product{' '}
          <C>&lt;#&gt;</C>) and a limit. For a result that came from a SQL query, name the source table (
          <C>schema.table</C>). You get the SQL to copy and run; Plasma does not run anything for you here.
        </P>
      ),
    },
    {
      id: 'postgis',
      title: 'PostGIS map preview',
      body: (
        <>
          <P>
            When a result has a <C>geometry</C>{' '}or <C>geography</C>{' '}column, <UI>Map preview (PostGIS)</UI>{' '}appears in the same
            menu. It draws GeoJSON geometries from a column as vector shapes fitted to their bounding box, locally; no map
            tiles are downloaded.
          </P>
          <Callout kind="note" title="Wrap the column in ST_AsGeoJSON">
            The preview understands GeoJSON only. Select the geometry as <C>ST_AsGeoJSON(geom)</C>; a raw geometry column
            (hex WKB) shows a hint instead of being drawn.
          </Callout>
        </>
      ),
    },
    {
      id: 'more',
      title: 'Also on PostgreSQL',
      body: (
        <UL>
          <LI>
            <Doc to="sql-editor#safe-run">Safe Run</Doc>{' '}and <B>EXPLAIN ANALYZE</B>{' '}with timing.
          </LI>
          <LI>
            <Doc to="schema-tools#structure">Structure editor</Doc>, <Doc to="schema-tools#schema-diff">schema diff</Doc>,{' '}
            <Doc to="schema-tools#migration-check">migration check</Doc>, <Doc to="schema-tools#import">import</Doc>,{' '}
            <Doc to="schema-tools#backup">backup and restore</Doc>{' '}and <Doc to="schema-tools#db-search">search in database</Doc>.
          </LI>
          <LI>
            Column types are shown by name, including enum type names, and enum columns edit with a picker of their labels.
          </LI>
          <LI>
            The <UI>Query timeout</UI>{' '}in <UI>Settings</UI>{' '}&rarr; <UI>Security</UI>{' '}sets <C>statement_timeout</C>{' '}for your
            queries. Open the palette with <Keys k="mod+k" />{' '}to reach any of the above by name.
          </LI>
        </UL>
      ),
    },
  ],
};
