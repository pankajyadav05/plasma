import { Callout } from '@/components/docs/callout';
import { DocTable } from '@/components/docs/doc-table';
import { Keys } from '@/components/docs/keys';
import { B, C, LI, P, UI, UL } from '@/components/docs/prose';
import type { DocPage } from './types';

type Row = [label: string, keys: string];

function Table({ rows, caption }: { rows: Row[]; caption: string }) {
  return (
    <DocTable
      caption={caption}
      head={['Action', 'Shortcut']}
      rows={rows.map(([label, k]) => [label, <Keys key={label} k={k} />])}
    />
  );
}

export const shortcuts: DocPage = {
  slug: 'shortcuts',
  title: 'Keyboard shortcuts and the palette',
  group: 'Reference',
  summary:
    'Every key Plasma listens for, in macOS and Windows/Linux form, and how the command palette finds tables, tabs, queries and commands.',
  sections: [
    {
      id: 'about',
      title: 'How shortcuts work',
      body: (
        <>
          <P>
            <Keys k="mod" />{' '}means <B>Cmd</B>{' '}on macOS and <B>Ctrl</B>{' '}on Windows and Linux. The same list is used by the
            native menus, the window and the editor, so a chord can only mean one thing. Press <Keys k="mod+/" />{' '}for a searchable
            cheat sheet (<UI>Keyboard shortcuts</UI>), or open <UI>Settings</UI>{' '}&rarr; <UI>Keymap</UI>, which lists the same
            shortcuts with a search box.
          </P>
          <Callout kind="note" title="Shortcuts are fixed for now">
            The Keymap section ends with &ldquo;Shortcuts can&rsquo;t be changed yet.&rdquo; Plasma has no way to rebind keys today, so
            there is nothing to configure.
          </Callout>
          <P>
            A shortcut only works where it makes sense: query keys need a SQL connection, and the palette hides commands that do not
            apply to the connected engine.
          </P>
        </>
      ),
    },
    {
      id: 'general',
      title: 'General',
      body: (
        <Table
          caption="General shortcuts"
          rows={[
            ['Command palette', 'mod+k'],
            ['Toggle AI panel', 'mod+l'],
            ['Keyboard shortcuts', 'mod+/'],
            ['Settings', 'mod+,'],
            ['Close Settings / History / Monitor', 'Escape'],
          ]}
        />
      ),
    },
    {
      id: 'tabs',
      title: 'Tabs and panes',
      body: (
        <>
          <Table
            caption="Tab shortcuts"
            rows={[
              ['New query tab', 'mod+t'],
              ['Close tab', 'mod+w'],
              ['Next tab', 'mod+shift+]'],
              ['Previous tab', 'mod+shift+['],
              ['Next pane', 'mod+alt+]'],
              ['Previous pane', 'mod+alt+['],
              ['Go to tab 1–9', 'mod+1'],
            ]}
          />
          <P>
            <Keys k="mod+1" />{' '}to <Keys k="mod+8" />{' '}go to the first eight tabs and <Keys k="mod+9" />{' '}goes to the last one. With split
            panes, the tab keys work inside the focused pane.
          </P>
        </>
      ),
    },
    {
      id: 'query',
      title: 'Query and files',
      body: (
        <Table
          caption="Query shortcuts"
          rows={[
            ['Run selection / at cursor', 'mod+Enter'],
            ['Run all', 'mod+shift+Enter'],
            ['Safe Run (dry run a write)', 'mod+alt+Enter'],
            ['Cancel query', 'mod+.'],
            ['Query history', 'mod+shift+h'],
            ['Export results as CSV', 'mod+shift+e'],
            ['Commit changes / save SQL file', 'mod+s'],
            ['Save SQL as…', 'mod+shift+s'],
            ['Open SQL file…', 'mod+o'],
            ['Refresh table data', 'mod+r'],
            ['Run search / SQL (OpenSearch)', 'mod+Enter'],
            ['Previous / next command in the Redis CLI (up and down arrows)', 'ArrowUp'],
          ]}
        />
      ),
    },
    {
      id: 'view',
      title: 'View and tools',
      body: (
        <>
          <Table
            caption="View shortcuts"
            rows={[
              ['Toggle sidebar', 'mod+b'],
              ['Toggle query editor', 'mod+j'],
              ['Toggle right sidebar (Details)', 'mod+shift+b'],
              ['Presentation mode (mask sensitive data)', 'mod+shift+m'],
              ['Codegen dialog', 'mod+shift+g'],
              ['Notebook dialog', 'mod+shift+n'],
              ['Schema diff', 'mod+shift+d'],
            ]}
          />
          <P>
            <Keys k="mod+s" />{' '}is contextual: in a table tab with staged edits it commits them; in a SQL tab it saves the file. Plain{' '}
            <Keys k="mod+h" />{' '}is deliberately not used for History, because it is &ldquo;Hide&rdquo; on macOS and Find and Replace in the editor on
            Windows and Linux.
          </P>
        </>
      ),
    },
    {
      id: 'editor',
      title: 'Editor',
      body: (
        <Table
          caption="Editor shortcuts"
          rows={[
            ['Beautify SQL', 'mod+i'],
            ['Beautify SQL (alternative)', 'mod+shift+f'],
            ['Ask AI about selection', 'mod+shift+l'],
            ['Toggle line comment (in editor)', 'mod+/'],
            ['Larger editor font', 'mod+='],
            ['Smaller editor font', 'mod+-'],
            ['Reset editor font size', 'mod+0'],
            ['Toggle word wrap', 'alt+z'],
          ]}
        />
      ),
    },
    {
      id: 'grid',
      title: 'Grid',
      body: (
        <>
          <Table
            caption="Grid shortcuts"
            rows={[
              ['Move the cell selection (arrow keys)', 'ArrowUp'],
              ['Next cell', 'Tab'],
              ['Previous cell', 'shift+Tab'],
              ['Row details', 'Enter'],
              ['Cell value viewer', 'Space'],
              ['Edit cell (edit mode)', 'F2'],
              ['Copy cell', 'mod+c'],
              ['Find in results', 'mod+f'],
              ['Clear selection / close find', 'Escape'],
              ['Previous / next statement result (with the left and right arrows)', 'alt+ArrowLeft'],
            ]}
          />
          <P>These grid keys are not in the main list; all but Select all appear in the cell menu, next to the action they trigger:</P>
          <Table
            caption="More grid shortcuts"
            rows={[
              ['Select all', 'mod+a'],
              ['Paste (edit mode)', 'mod+v'],
              ['Fill down / duplicate row (edit mode)', 'mod+d'],
              ['Delete or restore rows (edit mode)', 'mod+Backspace'],
              ['Set selection to NULL (edit mode)', 'mod+shift+Backspace'],
              ['Find & replace (edit mode)', 'mod+shift+h'],
              ['Peek the row a foreign key points at', 'alt+Enter'],
            ]}
          />
        </>
      ),
    },
    {
      id: 'palette',
      title: 'The command palette',
      body: (
        <>
          <P>
            <Keys k="mod+k" />{' '}(or <UI>Open anything</UI>{' '}in the top bar) opens a single search box. With nothing typed it shows groups:{' '}
            <UI>Actions</UI>, <UI>Open tabs</UI>, <UI>Tables</UI>, <UI>Saved queries</UI>, <UI>Redis keys</UI>, <UI>Indexes</UI>{' '}and{' '}
            <UI>Connections</UI>, depending on the engine. Type and it becomes one ranked list in which the best match is first whatever its
            kind. Choosing a connection connects to it; a table opens it; an action runs it.
          </P>
          <P>The actions include:</P>
          <UL>
            <LI>
              Run: <UI>Run query</UI>, <UI>Run all statements</UI>, <UI>Safe Run (dry run a write)</UI>, <UI>Cancel running query</UI>.
            </LI>
            <LI>
              Tabs and files: <UI>New query tab</UI>, <UI>Close tab</UI>, <UI>Open SQL file…</UI>, <UI>Save SQL to file…</UI>,{' '}
              <UI>Commit pending changes / save</UI>, <UI>Refresh</UI>, split-pane commands.
            </LI>
            <LI>
              Data: <UI>Beautify SQL</UI>, <UI>Export results as CSV</UI>{' '}/ <UI>JSON</UI>, <UI>Query history</UI>, <UI>Compare results…</UI>.
            </LI>
            <LI>
              Tools: <UI>Health advisor</UI>, <UI>Generate code…</UI>, <UI>Notebook…</UI>, <UI>Schema diff…</UI>, <UI>Check migration…</UI>,{' '}
              <UI>Back up database…</UI>, <UI>Restore database…</UI>, <UI>Roles and privileges…</UI>, <UI>Search in database…</UI>,{' '}
              <UI>Show diagram</UI>, <UI>Listen to notifications (LISTEN/NOTIFY)</UI>, <UI>Tail keyspace events</UI>.
            </LI>
            <LI>
              Interface: <UI>Toggle dark mode</UI>, <UI>Toggle presentation mode</UI>, toggles for the sidebars, editor, word wrap and font size,{' '}
              <UI>Settings</UI>, <UI>Keyboard shortcuts</UI>.
            </LI>
            <LI>
              Connections: <UI>New connection</UI>, <UI>Open connection string…</UI>, <UI>Open data file…</UI>, <UI>Open workspace folder…</UI>,{' '}
              <UI>Create support bundle…</UI>, <UI>Disconnect</UI>, and, in a DuckDB file session, <UI>Attach a Postgres connection to this DuckDB
              session…</UI>.
            </LI>
            <LI>
              <UI>Toggle AI assistant</UI>{' '}and <UI>Ask AI about this SQL</UI>.
            </LI>
          </UL>
          <P>
            <UI>Open connection string…</UI>{' '}opens a small dialog where you paste a URL such as{' '}
            <C>postgres://user@host:5432/database?sslmode=require</C>{' '}to start a connection from it.
          </P>
        </>
      ),
    },
  ],
};
