import { Callout } from '@/components/docs/callout';
import { CodeBlock } from '@/components/docs/code-block';
import { DocTable } from '@/components/docs/doc-table';
import { Shot } from '@/components/docs/figure';
import { Keys } from '@/components/docs/keys';
import { B, C, Doc, LI, P, UI, UL } from '@/components/docs/prose';
import type { DocPage } from './types';

export const sqlEditor: DocPage = {
  slug: 'sql-editor',
  title: 'SQL editor',
  group: 'Working with data',
  summary:
    'Write and run SQL on any of the five SQL engines: run a statement, a selection or a whole script, watch and cancel it, then keep what you wrote as files, snippets, history or notebooks.',
  sections: [
    {
      id: 'editing',
      title: 'Writing SQL',
      body: (
        <>
          <Shot k="pg-editor" caption="A three-statement script run with Run all; each statement has its own result tab." />
          <P>
            Open a SQL tab with <UI>New SQL query</UI>{' '}(<Keys k="mod+t" />). The editor is Monaco, the editor of VS Code,
            with SQL highlighting and the Paper theme. A status line under it shows the cursor (<C>Ln 12, Col 4</C>) and,
            in a script, <UI>statement 2 of 5</UI>.
          </P>
        </>
      ),
      subs: [
        {
          id: 'autocomplete',
          title: 'Autocomplete',
          body: (
            <>
              <P>Suggestions come from the schema of the connected database and update when you reconnect.</P>
              <UL>
                <LI>
                  After a dot (<C>alias.</C>{' '}or <C>schema.</C>) you get the columns of that table or the tables of that
                  schema. An alias used in <C>FROM</C>{' '}works.
                </LI>
                <LI>
                  After <C>FROM</C>, <C>JOIN</C>, <C>UPDATE</C>{' '}or <C>INTO</C>{' '}you get tables, with the estimated row
                  count. Tables outside <C>public</C>{' '}are shown schema-qualified.
                </LI>
                <LI>
                  Elsewhere you get tables, column names (with type, <C>pk</C>{' '}and <C>not null</C>), keywords and snippets.
                </LI>
              </UL>
              <P>
                The completion list is built from the schema Plasma already loaded; it does not send anything anywhere.
              </P>
            </>
          ),
        },
        {
          id: 'format',
          title: 'Beautify',
          body: (
            <P>
              <UI>Beautify</UI>{' '}(<Keys k="mod+i" />{' '}or <Keys k="mod+shift+f" />) reformats the SQL with upper-case
              keywords, two-space indentation and logical operators at the start of a line. If the formatter cannot parse
              your text it leaves it unchanged, so a half-written query is never lost.
            </P>
          ),
        },
        {
          id: 'editor-options',
          title: 'Font, wrap and files',
          body: (
            <>
              <P>
                The chevron next to Beautify (<UI>More editor actions</UI>) holds <UI>Ask AI about this SQL</UI>,{' '}
                <UI>Open SQL File…</UI>, <UI>Save to File…</UI>{' '}/ <UI>Save As…</UI>, <UI>Word Wrap</UI>,{' '}
                <UI>Larger Font</UI>{' '}and <UI>Smaller Font</UI>. The font size ranges from 10 to 24 px and is also in{' '}
                <UI>Settings</UI>{' '}&rarr; <UI>Editor</UI>. <Keys k="mod+s" />{' '}saves the tab to its <C>.sql</C>{' '}file (or, in
                a table tab with staged edits, commits them) and <Keys k="mod+shift+s" />{' '}saves under a new name.
              </P>
              <P>
                Select text and right-click for <UI>Save Selection as Snippet…</UI>.
              </P>
            </>
          ),
        },
        {
          id: 'variables',
          title: 'Query variables',
          body: (
            <>
              <P>
                Write a placeholder as <C>:name</C>, <C>:&apos;name&apos;</C>{' '}or <C>$name</C>{' '}and a variables bar opens above
                the results when you run. Placeholders inside strings, quoted identifiers, comments and dollar-quoted
                bodies are ignored, and so is a <C>::cast</C>. Each variable has a type:
              </P>
              <DocTable
                head={['Type', 'How the value is used']}
                rows={[
                  ['Text', 'Bound as a real parameter ($n).'],
                  ['Number, Date, Boolean, NULL', 'Sent as a typed parameter where the statement allows one; where Postgres cannot infer the type, Plasma writes the value in as a literal.'],
                  ['Raw SQL', 'Pasted into the statement exactly as typed (a table name, an expression). It is not escaped.'],
                ]}
              />
              <P>
                The bar remembers earlier values, and a workspace query stores its variables in the file.
              </P>
              <Callout kind="warning" title="Raw SQL is not escaped">
                Only use the <UI>Raw SQL</UI>{' '}type for text you wrote yourself. It is the one type that is put into the SQL
                text without escaping.
              </Callout>
            </>
          ),
        },
      ],
    },
    {
      id: 'running',
      title: 'Running SQL',
      body: (
        <>
          <DocTable
            head={['Action', 'Shortcut', 'What runs']}
            rows={[
              [<UI key="a">Run Selected</UI>, <Keys key="a2" k="mod+Enter" />, 'The selected text, if any.'],
              [<UI key="b">Run Current</UI>, <Keys key="b2" k="mod+Enter" />, 'With no selection, the statement the cursor is in. The button reads Run Selected or Run Current to match.'],
              [<UI key="c">Run All</UI>, <Keys key="c2" k="mod+shift+Enter" />, 'The whole buffer, statement by statement.'],
              [<UI key="d">Safe Run</UI>, <Keys key="d2" k="mod+alt+Enter" />, 'A dry run of an INSERT, UPDATE, DELETE or MERGE, or of a selected script of up to 20 of them (below).'],
              [<UI key="e">Cancel</UI>, <Keys key="e2" k="mod+." />, 'The statement that is running.'],
            ]}
          />
          <P>
            Plasma splits a script with a tokenizer that understands quotes, dollar-quoting and comments, so a semicolon
            inside a string does not end a statement. It runs the statements one after another and stops at the first
            error; the results of the statements that ran stay on screen, and the error says which statement failed
            (&ldquo;statement 3 of 5&rdquo;). psql meta-commands such as <C>\d</C>{' '}are not SQL and are refused, and{' '}
            <C>COPY … FROM STDIN</C>{' '}and <C>COPY … TO STDOUT</C>{' '}are refused with a pointer to Import or Export.
          </P>
          <P>
            Each statement of a script gets its own result tab with the row count and time. Switch between them with the
            tabs or <Keys k="alt+ArrowLeft" mac={false} />{' '}/ <Keys k="alt+ArrowRight" mac={false} />{' '}(<UI>⌥← / ⌥→</UI>{' '}on
            macOS).
          </P>
        </>
      ),
      subs: [
        {
          id: 'row-limit',
          title: 'Row limit',
          body: (
            <P>
              The <UI>Limit</UI>{' '}pill at the bottom right (also <UI>Settings</UI>{' '}&rarr; <UI>Editor</UI>{' '}&rarr;{' '}
              <UI>Row limit</UI>) caps how many rows are read per statement: 100, 300, 500, 1,000, 5,000 or{' '}
              <UI>No limit</UI>. Your SQL is never rewritten; Plasma just stops reading. Even with no limit, a result stops
              at 10,000 rows or about 32 MiB, and the grid is marked as truncated. To get everything, use{' '}
              <Doc to="results#export">Export</Doc>, which streams the full result to a file.
            </P>
          ),
        },
        {
          id: 'status',
          title: 'Status, queueing and cancel',
          body: (
            <>
              <P>
                A status chip shows <UI>Queued</UI>, <UI>Running</UI>{' '}or <UI>Cancelling</UI>{' '}with the time. Statements on
                one connection run one at a time: if another tab is using the connection, the chip reads{' '}
                <UI>Waiting for the connection</UI>{' '}and the query starts when the other one finishes.
              </P>
              <P>
                <UI>Cancel</UI>{' '}asks the server to stop the statement; on Postgres it uses a separate connection, so it
                works even while the main one is busy. If the server has not stopped it after a while, the chip offers{' '}
                <UI>Cancel again</UI>{' '}and <UI>Disconnect to stop it</UI>. After a cancel, the tab says <UI>Cancelled</UI>;
                if the statement finished first, that is shown instead.
              </P>
              <P>When a run does not succeed the result area explains why:</P>
              <UL>
                <LI>
                  <B>Query failed</B>: the server&rsquo;s message, with the position of the error underlined in the editor
                  where the engine reports one, and a <UI>Fix with AI</UI>{' '}button.
                </LI>
                <LI>
                  <B>Connection dropped</B>: a read can simply be run again once the connection is back.
                </LI>
                <LI>
                  <B>Outcome unknown</B>: a write whose answer never arrived. Plasma does not re-run it. The panel says
                  &ldquo;Nothing was re-run. Look at the data before you run it again.&rdquo; and, when it can tell which
                  table was written, offers <UI>Check the data</UI>.
                </LI>
              </UL>
              <P>
                <UI>Settings</UI>{' '}&rarr; <UI>Security</UI>{' '}&rarr; <UI>Query timeout</UI>{' '}sets <C>statement_timeout</C>{' '}for the
                queries you run. The default is no timeout; you can choose 5, 15, 30 or 60 seconds, or 5 or 15 minutes. Long exports and monitoring are not affected.
              </P>
            </>
          ),
        },
        {
          id: 'transactions',
          title: 'Transactions',
          body: (
            <P>
              Turn on <UI>Settings</UI>{' '}&rarr; <UI>Advanced</UI>{' '}&rarr; <UI>Transactions</UI>{' '}(&ldquo;Wrap every query in a
              transaction&rdquo;) and the top bar shows <UI>Transaction open</UI>{' '}with{' '}
              <UI>Commit transaction</UI>{' '}and <UI>Roll back transaction</UI>{' '}buttons. Grid edit batches use their own
              transaction, or a savepoint if one is already open. A transaction that is still open when Plasma restarts
              for an update is rolled back, and the update dialog tells you so.
            </P>
          ),
        },
        {
          id: 'safe-run',
          title: 'Safe Run',
          body: (
            <>
              <P>
                <UI>Safe Run</UI>{' '}(PostgreSQL only) executes an <C>INSERT</C>, <C>UPDATE</C>, <C>DELETE</C>{' '}or <C>MERGE</C>{' '}
                inside a transaction, shows you exactly which rows it changed, and waits for your decision. Nothing is saved
                until you click <UI>Commit</UI>; <UI>Roll back</UI>{' '}discards it.
              </P>
              <UL>
                <LI>
                  The review shows the row count (with a <C>+</C>{' '}when it is not exact), and a grid of the affected rows:
                  inserted, deleted and changed rows are tinted, and a changed cell shows <C>before → after</C>.
                  Unchanged rows of an UPDATE are hidden behind a count you can expand.
                </LI>
                <LI>
                  UPDATEs are paired by primary or unique key. Without one, rows are matched by their physical position,
                  and the panel says so. When rows cannot be matched at all, old and new rows are listed separately.
                </LI>
                <LI>
                  Above the <UI>Safe Run warning</UI>{' '}threshold (default 1,000 rows; choices 10, 100, 1,000, 10,000,
                  100,000) the panel warns and Commit turns red.
                </LI>
                <LI>
                  While a Safe Run waits for you, other statements on that connection are paused. An undecided one rolls
                  back by itself after the <UI>Safe Run timeout</UI>{' '}(default 5 minutes; 30 seconds to 30 minutes) so it
                  never holds locks open.
                </LI>
                <LI>
                  A connection can <UI>Always Safe Run writes</UI>: then Run on a write does a Safe Run first, and so does Run on a script of 2 to 20 writes (a script that mixes in anything else runs normally). This is on by
                  default for Prod connections. It is not available on a read-only connection.
                </LI>
              </UL>
              <P>
                Safe Run is for data changes. For DDL the panel tells you to use a normal run.
              </P>
              <P>
                <B>Scripts.</B>{' '}Select several statements and press <Keys k="mod+alt+Enter" />{' '}to Safe Run them as a script: up to 20{' '}
                <C>INSERT</C>, <C>UPDATE</C>, <C>DELETE</C>{' '}or <C>MERGE</C>{' '}statements (or <C>WITH</C>{' '}statements that end in
                one of those), run in order in one transaction. With no selection, Safe Run takes the statement at the cursor,
                as before.
              </P>
              <UL>
                <LI>
                  Every statement is checked before anything runs. Any other statement (a <C>SELECT</C>, DDL, <C>BEGIN</C>,{' '}
                  <C>COMMIT</C>, <C>ROLLBACK</C>, <C>SAVEPOINT</C>, <C>SET</C>, <C>VACUUM</C>, <C>CALL</C>, <C>DO</C>) refuses the
                  whole script and names the statement number. More than 20 statements is refused too. Empty statements are dropped.
                </LI>
                <LI>
                  The review lists the statements with their row counts and timings. Select one (arrow keys, then Enter) to see
                  its before and after rows. Later statements see the changes of earlier ones, so a statement&apos;s before
                  rows are as of that point in the script.
                </LI>
                <LI>
                  The row threshold applies to the total rows changed by the script, and <UI>Commit all</UI>{' '}turns red above it. The{' '}
                  <UI>Safe Run timeout</UI>{' '}covers the whole script: if it runs out, everything is rolled back. On a Prod
                  connection one confirmation lists every statement.
                </LI>
                <LI>
                  <UI>Undo last statement</UI>{' '}rolls back only the last statement that ran and leaves the earlier ones pending.
                  Repeat it as often as you like; undoing the only statement left rolls back the whole script.
                </LI>
                <LI>
                  If a statement fails, its own changes are undone, the script stops, and the statements after it are marked not
                  run. The earlier statements stay pending, and nothing is saved. <UI>Commit all</UI>{' '}is not offered; you can{' '}
                  <UI>Roll back all</UI>, or choose the separate <UI>Commit 1–n</UI>{' '}button to save only the statements that
                  succeeded. If the first statement fails, nothing is held open and the error is shown.
                </LI>
                <LI>
                  Each statement keeps up to 500 before and after rows, and the script as a whole up to 2,000 per side; the
                  panel says when rows are left out. Row counts keep counting past those limits (up to 1,000,000, shown with a +).
                </LI>
                <LI>
                  A committed script is one history entry holding the whole script; on a connection that is audited, each
                  committed statement gets its own <UI>Safe Run</UI>{' '}row.
                </LI>
              </UL>
            </>
          ),
        },
      ],
    },
    {
      id: 'explain',
      title: 'EXPLAIN',
      body: (
        <>
          <Shot k="pg-explain" caption="A query plan with timing (EXPLAIN ANALYZE) for a join and aggregate." />
          <P>
            <UI>Explain Analyze…</UI>{' '}in the Run menu opens the plan as a tree. It starts with a plain{' '}
            <C>EXPLAIN</C>, which executes nothing, titled <UI>Query plan</UI>. Each node shows planned rows and cost; the
            buttons are <UI>Copy JSON</UI>, <UI>Explain with AI</UI>{' '}and <UI>Run with ANALYZE</UI>. ANALYZE actually
            executes the statement to get real timings (<UI>Query plan with timing</UI>), adding planning and execution
            times, actual rows, the misestimate, and buffer hits and reads.
          </P>
          <UL>
            <LI>
              For a statement that writes, ANALYZE runs inside a transaction that is rolled back, and is gated like any
              other write (Prod and Safe mode confirmations apply). On a read-only connection it is off for those
              statements.
            </LI>
            <LI>Closing the dialog while ANALYZE runs cancels the statement.</LI>
            <LI>
              Plain EXPLAIN is available on PostgreSQL, MySQL/MariaDB, SQLite and ClickHouse; ANALYZE only on PostgreSQL.
              DuckDB has no plan view.
            </LI>
            <LI>
              <UI>Explain with AI</UI>{' '}sends the query and the summarised plan to your AI provider (see{' '}
              <Doc to="ai-assistant#tasks">AI tasks</Doc>) and may propose <C>CREATE INDEX CONCURRENTLY</C>{' '}statements, at
              most three. It only suggests; it does not run them.
            </LI>
          </UL>
        </>
      ),
    },
    {
      id: 'history-saved',
      title: 'History, saved queries and snippets',
      body: (
        <P>
          The left sidebar has three modes: <UI>Items</UI>, <UI>Queries</UI>{' '}and <UI>History</UI>.
        </P>
      ),
      subs: [
        {
          id: 'history',
          title: 'Query history',
          body: (
            <>
              <P>
                Plasma records every statement you run, whether it succeeded or failed, with its row count and duration. It
                keeps the newest 5,000 entries; older ones are removed as new ones arrive. Passwords in{' '}
                <C>PASSWORD &apos;…&apos;</C>{' '}literals and in <C>password=</C>{' '}connection strings are masked before an entry is
                stored, and error text is stripped of the values it quotes.
              </P>
              <UL>
                <LI>
                  The sidebar mode lists entries for the current connection with <UI>Search for history…</UI>. Each can{' '}
                  <UI>Open in new tab</UI>, <UI>Copy SQL</UI>, <UI>Save as query…</UI>{' '}or <UI>Delete from history</UI>.
                </LI>
                <LI>
                  <UI>History</UI>{' '}in the icon rail (<Keys k="mod+shift+h" />) opens the full browser: search the SQL, and
                  filter by connection, status (<UI>Succeeded</UI>{' '}or <UI>Errors</UI>) and duration (under 100 ms, 100 ms to
                  1 s, over 1 s). Entries can be saved as snippets or deleted, and the whole history can be cleared after a
                  confirmation. Its <UI>Audit</UI>{' '}tab is described under{' '}
                  <Doc to="safety-privacy#audit-log">Audit log</Doc>.
                </LI>
              </UL>
            </>
          ),
        },
        {
          id: 'saved-queries',
          title: 'Saved queries',
          body: (
            <P>
              In <UI>Queries</UI>{' '}mode, save the current tab with <UI>Save current tab</UI>{' '}and give it a name. Queries can be
              favourited, renamed, moved into folders (<UI>New folder…</UI>, <UI>Move to folder</UI>) and updated from the
              current tab (<UI>Update with current tab</UI>). They are stored locally. To share queries with a team, save
              them to a <Doc to="connections#workspaces">workspace</Doc>{' '}instead.
            </P>
          ),
        },
        {
          id: 'snippets',
          title: 'Snippets',
          body: (
            <>
              <P>
                The <UI>Snippets</UI>{' '}section of Queries mode lists built-in and your own snippets. Type a snippet&rsquo;s
                prefix in the editor and pick it from the completion list. The built-ins include <C>selw</C>{' '}(select where),{' '}
                <C>selg</C>{' '}(count by group), <C>join</C>, <C>antijoin</C>, <C>ins</C>, <C>upsert</C>, <C>updw</C>,{' '}
                <C>delw</C>, <C>cte</C>, <C>rcte</C>{' '}(recursive CTE), <C>win</C>, <C>winsum</C>, <C>cic</C>{' '}(create index
                concurrently), <C>ct</C>, <C>addcol</C>, <C>expa</C>, <C>dups</C>, <C>sizes</C>, <C>activity</C>{' '}and{' '}
                <C>casew</C>.
              </P>
              <P>
                Your snippets have a <UI>Name</UI>, a <UI>Prefix</UI>, a <UI>Description</UI>{' '}and a <UI>Body</UI>{' '}in
                Monaco snippet syntax: <C>$1</C>{' '}for tab stops, <C>{'${2:default}'}</C>{' '}for defaults, <C>{'${3|a,b|}'}</C>{' '}
                for choices and <C>$0</C>{' '}for the final position. Snippets can be imported and exported as JSON, and a
                workspace can carry its own.
              </P>
            </>
          ),
        },
      ],
    },
    {
      id: 'notebook',
      title: 'Notebooks',
      body: (
        <>
          <P>
            <UI>Notebook</UI>{' '}(<Keys k="mod+shift+n" />) opens a document of cells for the current connection: SQL cells and
            Markdown notes. Add a cell below any other, move it up or down, remove it, and run a SQL cell with the play
            button. A cell shows its result under it: the first 50 rows, with a note when more exist or the row limit was
            hit, and the last result when the cell holds several statements. <UI>Open in a tab</UI>{' '}runs the cell in a
            regular tab with the full grid.
          </P>
          <P>
            Markdown cells support headings, bold, italic, code, lists and links, with a preview toggle. The draft is
            kept per connection on this computer. <UI>Copy as Markdown</UI>{' '}and <UI>Download .plasma.md</UI>{' '}export it;{' '}
            <UI>Save to the open team workspace</UI>{' '}writes it to <C>.plasma/notebooks</C>.
          </P>
        </>
      ),
    },
  ],
};
