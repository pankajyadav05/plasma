import { DocTable } from '@/components/docs/doc-table';
import { Keys } from '@/components/docs/keys';
import { C, Doc, P, UI } from '@/components/docs/prose';
import type { DocPage } from './types';

export const settings: DocPage = {
  slug: 'settings',
  title: 'Settings reference',
  group: 'Reference',
  summary:
    'Every section of the Settings screen, with each setting by its label in the app, what it does and its default where the code gives one.',
  sections: [
    {
      id: 'about',
      title: 'Using the Settings screen',
      body: (
        <P>
          Open <UI>Settings</UI>{' '}with <Keys k="mod+," />, the Settings tile in the icon rail, or the palette. A list of sections is on
          the left with a <UI>Search settings…</UI>{' '}box that matches section names and the words they contain (try &ldquo;font&rdquo;, &ldquo;timeout&rdquo;
          or &ldquo;token&rdquo;). Settings apply as soon as you change them and are stored locally on your computer. <UI>Esc</UI>{' '}closes the screen.
        </P>
      ),
    },
    {
      id: 'general',
      title: 'General',
      body: (
        <DocTable
          head={['Setting', 'What it does']}
          rows={[
            [<UI key="a">On launch: Reconnect to the last connection</UI>, 'Reconnects when Plasma starts. Skipped after you disconnect on purpose. On by default.'],
            [<UI key="b">Restore open SQL tabs</UI>, "Reopens the last session's query tabs for each connection. On by default."],
            [<UI key="c">Connection lost: Retry automatically</UI>, 'Retries after 2, 5, 10, 30 and 60 seconds, and as soon as the network is back. On by default.'],
            [<UI key="d">Left sidebar: Hidden</UI>, 'Hides the left sidebar. Same as the sidebar toggle (Cmd or Ctrl+B).'],
          ]}
        />
      ),
    },
    {
      id: 'editor',
      title: 'Editor',
      body: (
        <DocTable
          head={['Setting', 'What it does']}
          rows={[
            [<UI key="a">Font size</UI>, '10 to 24 px. Default 13.'],
            [<UI key="b">Long lines: Wrap</UI>, 'Word wrap in the SQL editor.'],
            [<UI key="c">Row limit</UI>, <>Rows fetched per SQL statement: 100, 300, 500, 1,000, 5,000 or No limit. The SQL itself is never rewritten. See <Doc to="sql-editor#row-limit">Row limit</Doc>.</>],
            [<UI key="d">Migration linter</UI>, <>Check DDL for unsafe migrations. Flags blocking or rewriting DDL in Preview SQL panels and the SQL editor, with a safer alternative. On by default.</>],
            [<UI key="e">Show findings</UI>, 'All (info and above), Warnings and errors, or Errors only.'],
            [<UI key="f">Rules</UI>, 'A checkbox per lint rule. Untick a rule to mute it everywhere.'],
          ]}
        />
      ),
    },
    {
      id: 'table',
      title: 'Table & grid',
      body: (
        <>
          <DocTable
            head={['Setting', 'What it does']}
            rows={[
              [<UI key="a">Page size</UI>, 'Rows per page when you open a table: 50, 100, 250, 500 or 1,000. Default 50.'],
              [<UI key="b">Rows: Alternate row colours</UI>, 'Zebra striping in the grid. On by default.'],
              [<UI key="c">Row counts</UI>, <>Above this many rows a table shows the planner&rsquo;s estimate instead of running <C>count(*)</C>: Always count exactly, or estimate above 10,000, 100,000 (default), 1,000,000 or 10,000,000.</>],
            ]}
          />
          <P>
            <UI>CSV export defaults</UI>{' '}set where the export starts from: <UI>Delimiter</UI>{' '}(comma, semicolon, tab, pipe), <UI>Quote</UI>{' '}(double or
            single), <UI>NULL values</UI>{' '}(empty field or the word NULL), <UI>Line endings</UI>{' '}(LF or CRLF), <UI>Header</UI>{' '}(first line has column
            names) and <UI>Spreadsheet safety</UI>{' '}(prefix cells starting with <C>=</C> <C>+</C> <C>-</C> <C>@</C>{' '}with an apostrophe; on by default).
          </P>
        </>
      ),
    },
    {
      id: 'appearance',
      title: 'Fonts & themes',
      body: (
        <>
          <DocTable
            head={['Setting', 'What it does']}
            rows={[
              [<UI key="a">Appearance</UI>, 'Light or Dark.'],
              [<UI key="b">Palette</UI>, 'Changes colours only. There are fifteen palettes.'],
              [<UI key="c">Interface font</UI>, 'Default (system UI), Geist, Inter, Outfit, Plus Jakarta Sans, IBM Plex Sans or System UI.'],
              [<UI key="d">Data font</UI>, 'The result grid, column types and other monospaced data: Default (JetBrains Mono), JetBrains Mono, Geist Mono, IBM Plex Mono or System mono.'],
            ]}
          />
          <P>
            The palettes are Plasma (default), Catppuccin, Claude, Claymorphism, Neo Brutalism, Quantum Rose, Forest Canopy, Cyberpunk, Arctic,
            GitHub, Nord, Solarized, Gruvbox, Tokyo Night and Ros&eacute; Pine. The fonts are bundled with the app, so choosing one needs no download.
            <UI> Toggle dark mode</UI>{' '}is also in the command palette.
          </P>
        </>
      ),
    },
    {
      id: 'security',
      title: 'Security',
      body: (
        <DocTable
          head={['Setting', 'What it does']}
          rows={[
            [<UI key="a">Safe mode</UI>, <>The default level for connections without their own: Off, Confirm dangerous statements (default), Confirm every write, Confirm every statement, Read-only. Prod-tagged connections always confirm destructive statements; read-only connections never write. See <Doc to="safety-privacy#safe-mode">Safe mode</Doc>.</>],
            [<UI key="b">Safe Run warning</UI>, 'Safe Run warns, and Commit turns red, above this many rows: 10, 100, 1,000 (default), 10,000 or 100,000.'],
            [<UI key="c">Safe Run timeout</UI>, 'A Safe Run left undecided this long rolls back by itself: 30 seconds, 1, 5 (default), 15 or 30 minutes.'],
            [<UI key="d">Query timeout</UI>, 'Sets statement_timeout for every query you run: No timeout (default), 5, 15, 30 or 60 seconds, 5 or 15 minutes. Long exports and monitoring are not affected.'],
            [<UI key="e">Presentation mode: Mask sensitive data on screen</UI>, 'Hides emails, phones, card numbers, IPs and sensitive-looking columns on screen, in the clipboard and in the AI context. Display only.'],
            [<UI key="f">Masking style</UI>, 'First letter, Last four or Everything. Passwords, tokens and secrets are always fully masked.'],
            [<UI key="g">Audit log: Record every connection, not only Prod</UI>, 'Statements on Prod-tagged connections are always logged.'],
            [<UI key="h">Audit retention</UI>, 'Older entries are deleted: 30, 90 (default), 180, 365 or 1,095 days. The remaining log still verifies.'],
          ]}
        />
      ),
    },
    {
      id: 'ai',
      title: 'AI',
      body: (
        <>
          <DocTable
            head={['Setting', 'What it does']}
            rows={[
              [<UI key="a">Provider</UI>, 'OpenRouter or Local model.'],
              [<UI key="b">OpenRouter API key</UI>, 'Your key, encrypted with the OS keychain and never shown again. Remove key deletes it.'],
              [<UI key="c">Server URL</UI>, 'Local model only. Ollama http://127.0.0.1:11434/v1 (the default); LM Studio http://127.0.0.1:1234/v1. Only localhost addresses are accepted.'],
              [<UI key="d">Model</UI>, 'The model picker. Type an id that is not listed to use it.'],
              [<UI key="e">Schema context</UI>, 'Send table and column names, sample Redis keys and cluster summaries in the AI system prompt. On by default. Prod-tagged connections send it only after you enable AI access on that connection.'],
              [<UI key="f">Agent: Apply view changes without asking</UI>, 'When the agent shows a table with new columns, sort, filters or page size, apply it at once (with Undo). Running queries and changing data always ask first. Off by default.'],
            ]}
          />
          <P>
            More on <Doc to="ai-assistant">the AI assistant</Doc>.
          </P>
        </>
      ),
    },
    {
      id: 'mcp',
      title: 'MCP server',
      body: (
        <P>
          Turn on the MCP server, set the port, show, copy or regenerate the token, copy a client snippet, choose per-connection access and read the
          activity log. See <Doc to="mcp-server">MCP server</Doc>.
        </P>
      ),
    },
    {
      id: 'keymap',
      title: 'Keymap',
      body: (
        <P>
          A read-only, searchable list of every shortcut. &ldquo;Shortcuts can&rsquo;t be changed yet.&rdquo; See{' '}
          <Doc to="shortcuts">Keyboard shortcuts</Doc>.
        </P>
      ),
    },
    {
      id: 'advanced',
      title: 'Advanced',
      body: (
        <>
          <DocTable
            head={['Setting', 'What it does']}
            rows={[
              [<UI key="a">Transactions: Wrap every query in a transaction</UI>, 'Commit or roll back from the toolbar. Edit batches use their own transaction (or a savepoint if one is already open). Off by default.'],
              [<UI key="b">PostgreSQL tools</UI>, 'The folder with pg_dump, pg_restore and psql for backup and restore. Leave it empty to use PATH.'],
              [<UI key="c">Command line</UI>, <>Install the <C>plasma</C>{' '}command (macOS, Linux) or see the instructions to add it to PATH (Windows). See <Doc to="command-line">Command line</Doc>.</>],
            ]}
          />
          <P>
            <UI>About</UI>{' '}shows the version you run, when updates were last checked, <UI>Check now</UI>, and <UI>Restart to update</UI>{' '}or{' '}
            <UI>Download</UI>{' '}when an update is ready; see <Doc to="install#updates">Updates</Doc>. <UI>Create support bundle…</UI>{' '}is described under{' '}
            <Doc to="reliability#support-bundle">Support bundle</Doc>. A line states that preferences are stored locally on this computer.
          </P>
        </>
      ),
    },
  ],
};
