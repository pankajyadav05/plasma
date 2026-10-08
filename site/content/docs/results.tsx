import { Callout } from '@/components/docs/callout';
import { DocTable } from '@/components/docs/doc-table';
import { Shot } from '@/components/docs/figure';
import { Keys } from '@/components/docs/keys';
import { B, C, Doc, LI, P, UI, UL } from '@/components/docs/prose';
import { Steps } from '@/components/docs/steps';
import type { DocPage } from './types';

export const results: DocPage = {
  slug: 'results',
  title: 'Results and editing data',
  group: 'Working with data',
  summary:
    'The result grid, filters and sorting, the value viewer, editing cells with a reviewable commit, conflict detection, foreign-key navigation, export, charts, Result Compare and presentation mode.',
  sections: [
    {
      id: 'grid',
      title: 'The grid',
      body: (
        <>
          <Shot k="pg-workbench" caption="A table in the grid. The selected row shows in the Details panel." />
          <P>
            A table tab opens a table in pages; a SQL tab shows the result of the statement you ran. A table tab has three
            views, chosen at the bottom left: <UI>Data</UI>{' '}(rows), <UI>Structure</UI>{' '}(columns, constraints, indexes) and{' '}
            <UI>DDL</UI>{' '}(the <C>CREATE TABLE</C>{' '}definition). A SQL result has <UI>Data</UI>, <UI>Message</UI>{' '}(notices and
            errors, with a dot when there is something to read) and <UI>Chart</UI>. A script that fails part-way keeps the
            results of the statements that ran and adds an Error tab.
          </P>
        </>
      ),
      subs: [
        {
          id: 'moving',
          title: 'Selecting and moving',
          body: (
            <>
              <DocTable
                head={['Do this', 'Result']}
                rows={[
                  [<Keys key="a" k="ArrowUp" mac={false} />, 'Arrow keys move the cell selection. Add Ctrl or Cmd to jump to the first or last row or column; Home, End, PageUp and PageDown also work.'],
                  [<><Keys k="Tab" mac={false} />{' '}/ <Keys k="shift+Tab" mac={false} /></>, 'Next or previous cell.'],
                  ['Drag, or Shift+click', 'Select a range of cells.'],
                  [<Keys key="b" k="Space" mac={false} />, 'Open the value viewer for the cell.'],
                  [<Keys key="c" k="Enter" mac={false} />, 'Open the row in the Details panel.'],
                  [<Keys key="d" k="mod+f" />, 'Find in results.'],
                  [<Keys key="e" k="mod+c" />, 'Copy the cell or the selected range.'],
                  [<Keys key="f" k="Escape" mac={false} />, 'Clear the selection or close the find bar.'],
                ]}
              />
              <P>
                When a range with numbers is selected, the footer shows its count, sum and average; click it for count, sum,
                average, minimum and maximum of every selected column (dates get minimum and maximum, and every column gets a
                NULL count).
              </P>
            </>
          ),
        },
        {
          id: 'columns',
          title: 'Columns',
          body: (
            <>
              <P>
                Right-click a column header, or use the menu button on it, for <UI>Sort ascending</UI>,{' '}
                <UI>Sort descending</UI>, <UI>Clear sort</UI>, <UI>Filter by this column…</UI>{' '}(table tabs),{' '}
                <UI>Freeze columns up to here</UI>, <UI>Unfreeze all columns</UI>, <UI>Auto-fit width</UI>,{' '}
                <UI>Hide column</UI>{' '}and <UI>Copy column name</UI>. The <UI>Columns</UI>{' '}button in the toolbar lists every
                column with a show/hide toggle, a search box and <UI>Hide every column</UI>. In a table tab you can sort by
                several columns (<UI>Sort</UI>{' '}lists the active keys, each with a button to flip its direction or remove
                it).
              </P>
              <P>
                The header menu also has <UI>Mark as sensitive</UI>, <UI>Not sensitive: stop masking</UI>{' '}and{' '}
                <UI>Reset masking to automatic</UI>{' '}for <Doc to="results#presentation">presentation mode</Doc>.
              </P>
            </>
          ),
        },
        {
          id: 'filtering',
          title: 'Filtering a table',
          body: (
            <>
              <P>
                In a table tab, add a filter from the filter bar, from <UI>Filter by this column…</UI>, or from the cell
                context menu (<UI>Filter: column = value</UI>). Filters are combined with AND, and each shows as a chip you can
                edit. The operators offered depend on the column&rsquo;s type:
              </P>
              <DocTable
                head={['Type', 'Operators']}
                rows={[
                  ['Numbers, dates, UUIDs', '=, !=, >, <, >=, <=, between, in list, not in list, is null, is not null'],
                  ['Text and JSON', '=, !=, contains (ILIKE), matches (LIKE), does not contain, does not match, in list, not in list, is null, is not null. Contains is the default.'],
                  ['Booleans', '=, !=, is null, is not null'],
                  ['Other types', '=, !=, the pattern operators, is null, is not null'],
                ]}
              />
              <P>
                Pattern values are wrapped in <C>%</C>{' '}by the app. For <UI>in list</UI>{' '}type values separated by commas, and for{' '}
                <UI>between</UI>{' '}type <C>low, high</C>. A small button shows <UI>Query sent for this view</UI>, the exact SQL
                behind your filters, sort and page. <UI>Ask</UI>{' '}in the same bar takes a plain-English description of the
                view; see <Doc to="ai-assistant#tasks">AI tasks</Doc>.
              </P>
            </>
          ),
        },
        {
          id: 'paging',
          title: 'Paging and row counts',
          body: (
            <P>
              The footer has <UI>Previous page</UI>, <UI>Next page</UI>, <UI>Page settings</UI>{' '}(rows per page: 50, 100, 300,
              500 or 1,000; the default for newly opened tables is 50 and is set in <UI>Settings</UI>{' '}&rarr; <UI>Table &amp; grid</UI>{' '}&rarr; <UI>Page size</UI>, which offers 50, 100, 250, 500 or 1,000) and a{' '}
              <UI>Go to page</UI>{' '}box. On PostgreSQL, a table bigger than the <UI>Row counts</UI>{' '}threshold (default
              100,000 rows) shows the planner&rsquo;s estimate from <C>pg_class.reltuples</C>{' '}instead of running{' '}
              <C>count(*)</C>; the tooltip says so. Set the threshold to <UI>Always count exactly</UI>{' '}to turn that off.
            </P>
          ),
        },
        {
          id: 'value-viewer',
          title: 'Value viewer and row details',
          body: (
            <>
              <P>
                <Keys k="Space" mac={false} />{' '}(or a double-click on a cell you cannot edit) opens the full value in a
                popover with the column name and type, a <UI>Copy</UI>{' '}button and the character count. JSON is shown as a
                tree with a <UI>Filter keys / values…</UI>{' '}box. If the cell is a foreign key, a <UI>Referenced by</UI>{' '}list
                links to the tables that point at it.
              </P>
              <P>
                <Keys k="Enter" mac={false} />{' '}shows the whole row as a form in the <UI>Details</UI>{' '}panel (right sidebar,{' '}
                <Keys k="mod+shift+b" />), with <UI>Search for field…</UI>, per-field <UI>Copy</UI>{' '}and{' '}
                <UI>Copy row as JSON</UI>. With no row selected it shows the table&rsquo;s total, data and index size, estimated rows
                and comment.
              </P>
            </>
          ),
        },
      ],
    },
    {
      id: 'editing',
      title: 'Editing cells',
      body: (
        <>
          <P>
            Editing is deliberate. Turn on <UI>edit mode</UI>{' '}(the lock button in the top bar), and the footer gains{' '}
            <UI>+ Row</UI>{' '}and <UI>Delete row</UI>{' '}buttons. Nothing is written when you change a cell; the change is{' '}
            <B>staged</B>, and the top bar counts the staged changes next to the <UI>Commit</UI>{' '}button.
          </P>
          <Steps
            items={[
              {
                title: 'Change cells',
                body: (
                  <P>
                    Double-click a cell, press <Keys k="F2" mac={false} />{' '}or start typing. Type-aware editors open for JSON,
                    arrays, dates, times, timestamps (with and without time zone), enums, booleans, UUIDs (with a generate
                    button) and binary data (bytea, editable up to a size limit). <Keys k="Enter" mac={false} />{' '}commits the
                    edit to the staging area, <Keys k="Tab" mac={false} />{' '}moves on.
                  </P>
                ),
              },
              {
                title: 'Review',
                body: (
                  <P>
                    <UI>Preview pending changes</UI>{' '}in the top bar lists every staged change, summarises them (for example
                    &ldquo;3 updates, 1 insert&rdquo;) and says they commit as one transaction. <UI>Discard pending changes</UI>{' '}
                    throws them all away. A single change can be removed from the cell menu (<UI>Discard change</UI>).
                  </P>
                ),
              },
              {
                title: 'Commit',
                body: (
                  <P>
                    <UI>Commit</UI>{' '}(<Keys k="mod+s" />{' '}in a table tab) writes everything in one transaction. If anything
                    fails, nothing is saved and the error appears on the button and on the grid. On a Prod connection, or
                    under a Safe mode that asks, you confirm first (&ldquo;Commit changes to production?&rdquo;).
                  </P>
                ),
              },
            ]}
          />
        </>
      ),
      subs: [
        {
          id: 'edit-actions',
          title: 'More than one cell at once',
          body: (
            <UL>
              <LI>
                <UI>Insert row</UI>{' '}(<UI>+ Row</UI>) opens a form; blank fields use the column default or NULL. The row is
                queued as a pending insert. <UI>Duplicate row</UI>{' '}copies a row the same way.
              </LI>
              <LI>
                <UI>Delete row</UI>{' '}marks the selected rows for deletion; they are removed on commit and can be restored
                before that. A table with no primary key cannot delete rows safely, and the button says so.
              </LI>
              <LI>
                <UI>Set NULL</UI>, <UI>Set value…</UI>{' '}(one value for every selected cell) and <UI>Fill down</UI>{' '}(
                <Keys k="mod+d" />) work on a selected range. <UI>Find &amp; replace…</UI>{' '}(<Keys k="mod+shift+h" />) stages
                replacements across the results so you can review them.
              </LI>
              <LI>
                <UI>Paste</UI>{' '}pastes a block of cells. If it runs past the last loaded row Plasma asks whether to add the
                extra rows as new rows.
              </LI>
            </UL>
          ),
        },
        {
          id: 'conflicts',
          title: 'Conflict detection',
          body: (
            <>
              <P>
                Two people can edit the same table. Plasma does not overwrite a change it cannot see: the statement for an
                update carries the values you saw in the columns you changed, and a delete carries the whole row you saw. If
                the row was changed (or removed) since you loaded it, the statement matches nothing and Plasma reports a
                conflict instead of saving.
              </P>
              <P>
                Nothing is saved when this happens and all your edits stay staged. A dialog titled{' '}
                <UI>A row changed while you were editing</UI>{' '}shows, per row, the value you loaded, the value on the server now
                and yours. Choose <UI>Keep mine</UI>{' '}to re-stage your change on top of the new values, or{' '}
                <UI>Take theirs</UI>{' '}(<UI>Drop my change</UI>{' '}when the row is gone) to give yours up. Closing the dialog keeps
                everything staged.
              </P>
              <UL>
                <LI>Columns whose values exceed 64 KiB, or whose type has no usable equality, are not compared.</LI>
                <LI>
                  On MySQL, text is compared with the column&rsquo;s collation, so a change of letter case alone can go
                  unnoticed on a case-insensitive collation.
                </LI>
                <LI>
                  A new row that uses a key which already exists is reported (&ldquo;uses a key that already exists&rdquo;) rather than
                  overwriting anything.
                </LI>
              </UL>
            </>
          ),
        },
        {
          id: 'which-engines',
          title: 'Where grid editing works',
          body: (
            <P>
              PostgreSQL, MySQL/MariaDB and SQLite edit through the grid. ClickHouse and DuckDB results are read-only in the
              grid (the lock button says &ldquo;Rows are read-only for this engine&rdquo;); change data there with SQL. Redis and
              OpenSearch have their own editors. A read-only connection never lets you edit.
            </P>
          ),
        },
      ],
    },
    {
      id: 'fk',
      title: 'Foreign-key navigation',
      body: (
        <>
          <P>
            A cell that holds a foreign key shows a small arrow. Click it to open the referenced table filtered to the row
            the value points at (composite keys work). Hover the arrow for about half a second, or press{' '}
            <Keys k="alt+Enter" mac={false} />{' '}or Alt/Option-click the cell, to <B>peek</B>{' '}at that row in a popover with an{' '}
            <UI>Open</UI>{' '}button, without leaving your tab.
          </P>
          <P>
            The cell menu also lists <UI>Open &lt;table&gt; row</UI>, <UI>Peek &lt;table&gt; row</UI>{' '}and a{' '}
            <UI>Referenced by</UI>{' '}list (the other direction): tables whose foreign keys point at this row, with a count, so
            you can go from an order to its items. Longer lists continue in the Details panel.
          </P>
        </>
      ),
    },
    {
      id: 'export',
      title: 'Export and copy',
      body: (
        <>
          <P>
            The <UI>Export</UI>{' '}button offers <UI>CSV</UI>, <UI>JSON</UI>{' '}and <UI>SQL INSERT</UI>, and a <UI>Copy as</UI>{' '}
            row with <UI>Markdown</UI>, <UI>HTML</UI>{' '}and <UI>TSV</UI>. A scope switch chooses what to export:
          </P>
          <UL>
            <LI>
              <UI>Selected</UI>{' '}&mdash; the selected rows;
            </LI>
            <LI>
              <UI>Loaded</UI>{' '}/ <UI>All rows</UI>{' '}&mdash; what is in the grid now;
            </LI>
            <LI>
              <UI>Whole table</UI>, <UI>All matching</UI>{' '}(when filters are set) or <UI>Full result</UI>{' '}&mdash; the data beyond
              what is loaded. The server query is run again and streamed straight to the file, so size is not limited by
              memory. For a SQL result this re-runs the statement only if it is a single read-only query; a statement that
              changes data is never re-executed for an export.
            </LI>
          </UL>
          <P>
            A progress bar shows the running export (<C>Exporting CSV · …</C>) with a <UI>Cancel</UI>{' '}button. Shortcut:{' '}
            <Keys k="mod+shift+e" />{' '}exports CSV. In the grid, <UI>Copy selection as</UI>{' '}offers tab-separated (with or without
            header), CSV (with or without header), JSON, Markdown and SQL INSERT.
          </P>
          <P>
            CSV defaults live in <UI>Settings</UI>{' '}&rarr; <UI>Table &amp; grid</UI>: delimiter (comma, semicolon, tab or pipe),
            quote, NULL as empty or the word NULL, LF or CRLF line endings, a header row, and{' '}
            <UI>Spreadsheet safety</UI>, which prefixes cells starting with <C>=</C>, <C>+</C>, <C>-</C>{' '}or <C>@</C>{' '}with an
            apostrophe so Excel and Sheets do not run them as formulas (on by default). In presentation mode, values you copy to the clipboard are masked.
          </P>
        </>
      ),
    },
    {
      id: 'charts',
      title: 'Charts',
      body: (
        <P>
          Switch a SQL result to <UI>Chart</UI>{' '}(enabled when it has rows). Choose a <UI>Type</UI>{' '}(bar, line or area), an{' '}
          <UI>X axis</UI>{' '}column and one or more <UI>Y axis</UI>{' '}columns; only numeric columns are offered for Y. A chart plots at most
          the first 200 points of the result. It is drawn locally from the rows you already loaded.
        </P>
      ),
    },
    {
      id: 'compare',
      title: 'Result Compare',
      body: (
        <>
          <P>
            <UI>Compare with…</UI>{' '}(the compare button in the result footer, or <UI>Compare results…</UI>{' '}in the palette)
            diffs two result sets. The second side can be another tab&rsquo;s result, or the same query run read-only on any
            other saved SQL connection &mdash; staging against production, say. It opens in its own tab.
          </P>
          <UL>
            <LI>
              Pick a <UI>Key</UI>: the columns that identify the same row on both sides. Plasma suggests keys. With no key,
              whole rows are matched, so a changed row shows as one removed and one added; with a key, a change shows cell by
              cell.
            </LI>
            <LI>
              <UI>Ignore</UI>{' '}columns such as <C>updated_at</C>; set a numeric <UI>± tolerance</UI>; ignore case; trim and
              collapse whitespace.
            </LI>
            <LI>
              Columns are matched by name. NULL equals NULL and never equals an empty string. Numbers compare as numbers (
              <C>1.50</C>{' '}equals <C>1.5</C>), and integers past 2<sup>53</sup>{' '}compare exactly. A key that appears twice on
              one side is reported as a duplicate instead of being merged.
            </LI>
            <LI>
              Filter by added, removed, changed, unchanged or duplicate rows. Export the differences as CSV or JSON. A
              comparison can be saved by name (it stores the queries, connections, key and ignore rules, not the rows) and run
              again later.
            </LI>
            <LI>Each side is capped at 200,000 rows; a truncated side is flagged.</LI>
          </UL>
        </>
      ),
    },
    {
      id: 'presentation',
      title: 'Presentation mode and masking',
      body: (
        <>
          <P>
            For screen sharing and demos, <UI>presentation mode</UI>{' '}(<Keys k="mod+shift+m" />, or{' '}
            <UI>Settings</UI>{' '}&rarr; <UI>Security</UI>) masks sensitive data on screen. It hides emails, phone numbers, card
            numbers, IP addresses and columns whose names look like <C>password</C>, <C>token</C>, <C>address</C>{' '}and so on, in
            the grid, the details panel, the value viewer, the clipboard and the AI context, and the host name in the title and
            the connection capsule. Masking is display only: nothing stored changes, and edits and keys still use the real
            values.
          </P>
          <UL>
            <LI>
              <B>Masking style</B>{' '}(<UI>Settings</UI>{' '}&rarr; <UI>Security</UI>): <UI>First letter</UI>{' '}(
              <C>a•••@example.com</C>), <UI>Last four</UI>{' '}(<C>•••• 4242</C>) or <UI>Everything</UI>{' '}(<C>•••</C>). Passwords,
              tokens and secrets are always fully masked.
            </LI>
            <LI>
              Per connection, mark a column <UI>Mark as sensitive</UI>{' '}or <UI>Not sensitive: stop masking</UI>{' '}from the column
              header menu when the automatic detection is wrong.
            </LI>
            <LI>
              A masked cell offers <UI>Reveal value (10 s)</UI>{' '}from its menu, and <UI>Mask value again</UI>.
            </LI>
          </UL>
          <Callout kind="note">
            AI tool results and the <Doc to="mcp-server">MCP server</Doc>{' '}mask values independently of presentation mode; see
            those pages.
          </Callout>
        </>
      ),
    },
  ],
};
