import { Callout } from '@/components/docs/callout';
import { CodeBlock } from '@/components/docs/code-block';
import { DocTable } from '@/components/docs/doc-table';
import { B, C, Doc, LI, P, UI, UL } from '@/components/docs/prose';
import { Steps } from '@/components/docs/steps';
import type { DocPage } from './types';

export const mcpServer: DocPage = {
  slug: 'mcp-server',
  title: 'MCP server',
  group: 'AI',
  summary:
    'Let Claude Code, Cursor, Codex or Claude Desktop use your databases through Plasma, with per-connection access levels, masked results, read-only queries, and changes that only run after you approve them in Plasma.',
  sections: [
    {
      id: 'what',
      title: 'What it is',
      body: (
        <>
          <P>
            MCP (the Model Context Protocol) is how AI coding tools call external tools. Plasma can act as an MCP server so a tool
            such as Claude Code can look at the structure of a database, run read-only queries and <B>propose</B>{' '}changes, without
            ever receiving a password or a host name. Everything goes through Plasma, so Plasma&rsquo;s own rules apply.
          </P>
          <UL>
            <LI>
              It is <B>off by default</B>, and every connection starts with no access.
            </LI>
            <LI>Tools read in a read-only session, with sensitive values masked.</LI>
            <LI>A tool can only change data when you approve the exact statement in Plasma.</LI>
            <LI>Tools never get a password, host, user or file path.</LI>
          </UL>
          <Callout kind="note" title="This is separate from the in-app assistant">
            The <Doc to="ai-assistant">AI assistant</Doc>{' '}is Plasma calling a model. The MCP server is the reverse: your AI tool
            calling Plasma. What the AI tool then sends to its own vendor is up to that tool, not Plasma.
          </Callout>
        </>
      ),
    },
    {
      id: 'enable',
      title: 'Turn it on',
      body: (
        <>
          <Steps
            items={[
              {
                title: 'Enable the server',
                body: (
                  <P>
                    <UI>Settings</UI>{' '}&rarr; <UI>MCP server</UI>{' '}&rarr; <UI>Turn on the MCP server</UI>. A status line shows whether
                    it is listening, or why it is not (for example when the port is in use).
                  </P>
                ),
              },
              {
                title: 'Check the port',
                body: (
                  <P>
                    The default port is <C>47321</C>. You can pick any port from 1024 to 65535; the server listens on{' '}
                    <C>127.0.0.1</C>{' '}only.
                  </P>
                ),
              },
              {
                title: 'Copy the setup for your client',
                body: (
                  <P>
                    Choose <UI>Claude Code</UI>, <UI>Cursor</UI>, <UI>Codex</UI>{' '}or <UI>Claude Desktop</UI>. Settings shows the exact
                    snippet with your port and a hidden token; <UI>Copy</UI>{' '}copies it with the real token.
                  </P>
                ),
              },
              {
                title: 'Give a connection access',
                body: (
                  <P>
                    In <UI>What AI tools may do</UI>, choose an access level for each saved connection. Nothing is visible to a tool
                    until you do.
                  </P>
                ),
              },
            ]}
          />
        </>
      ),
    },
    {
      id: 'clients',
      title: 'Client setup',
      body: (
        <>
          <P>
            These are the forms Settings generates. <C>&lt;token&gt;</C>{' '}stands for the token shown (and copied) there; the port is
            the one you set.
          </P>
        </>
      ),
      subs: [
        {
          id: 'claude-code',
          title: 'Claude Code',
          body: (
            <>
              <P>Run this once in a terminal.</P>
              <CodeBlock
                label="Terminal"
                code='claude mcp add --transport http plasma http://127.0.0.1:47321/mcp --header "Authorization: Bearer <token>"'
              />
            </>
          ),
        },
        {
          id: 'cursor',
          title: 'Cursor',
          body: (
            <>
              <P>
                Add it to <C>~/.cursor/mcp.json</C>.
              </P>
              <CodeBlock
                label="~/.cursor/mcp.json"
                code={JSON.stringify(
                  { mcpServers: { plasma: { url: 'http://127.0.0.1:47321/mcp', headers: { Authorization: 'Bearer <token>' } } } },
                  null,
                  2,
                )}
              />
            </>
          ),
        },
        {
          id: 'codex',
          title: 'Codex',
          body: (
            <>
              <P>
                Add it to <C>~/.codex/config.toml</C>.
              </P>
              <CodeBlock
                label="~/.codex/config.toml"
                code={['[mcp_servers.plasma]', 'url = "http://127.0.0.1:47321/mcp"', 'http_headers = { "Authorization" = "Bearer <token>" }'].join('\n')}
              />
            </>
          ),
        },
        {
          id: 'claude-desktop',
          title: 'Claude Desktop and other stdio clients',
          body: (
            <>
              <P>
                Clients that only speak stdio use a bridge that Plasma ships: <C>plasma mcp</C>. It reads the port and the token from
                Plasma&rsquo;s own folder, so no token goes into the config file. Add the snippet to the client&rsquo;s MCP config file.
                If you have installed the <Doc to="command-line">command-line tool</Doc>, Settings shows the short form (
                <C>command</C>{' '}is the installed <C>plasma</C>{' '}and <C>args</C>{' '}is <C>[&quot;mcp&quot;]</C>); otherwise it shows the app
                binary with <C>--plasma-mcp-bridge</C>.
              </P>
              <CodeBlock
                label="MCP config (with the command-line tool installed)"
                code={JSON.stringify({ mcpServers: { plasma: { command: '/path/to/plasma', args: ['mcp'] } } }, null, 2)}
              />
              <P>
                If Plasma is not running or the server is off, the bridge answers{' '}
                <C>Open Plasma and turn on the MCP server in Settings.</C>
              </P>
            </>
          ),
        },
      ],
    },
    {
      id: 'access',
      title: 'Per-connection access',
      body: (
        <>
          <DocTable
            head={['Level', 'The tool may']}
            rows={[
              ['Off', 'Nothing. The connection is not listed.'],
              ['Structure only', 'List the connection and read its structure and notes.'],
              ['Structure and read queries', 'Also run read-only queries.'],
              ['Read, and propose changes', 'Also propose one statement at a time for you to approve.'],
            ]}
          />
          <UL>
            <LI>
              A connection saved as <B>Read-only</B>{' '}cannot be set higher than read queries; the propose option is disabled and
              marked.
            </LI>
            <LI>
              For a <B>production</B>{' '}connection with read or propose access, Settings warns that AI tools will read live data (and
              can propose changes to it).
            </LI>
            <LI>
              <UI>Send unmasked values to MCP clients</UI>{' '}(shown for read and propose levels) turns masking off for that connection.
              Leave it off unless you need real values.
            </LI>
            <LI>
              You can also reach the setting from the Connections home: <UI>Allow AI tools…</UI>{' '}on a saved connection.
            </LI>
          </UL>
        </>
      ),
    },
    {
      id: 'tools',
      title: 'The seven tools',
      body: (
        <>
          <DocTable
            head={['Tool', 'Needs', 'What it does']}
            rows={[
              [<C key="1">list_connections</C>, 'Any access', 'The connections you allowed: id, name, engine, access level, read-only, production and whether it is open in Plasma. Never a host, user or path.'],
              [<C key="2">get_schema</C>, 'Structure', 'Tables, columns, types, primary and foreign keys; pass a schema and table to narrow it, which also adds indexes. SQL engines.'],
              [<C key="3">run_query</C>, 'Read queries', <>One read-only statement (SELECT, WITH, EXPLAIN, SHOW, VALUES, TABLE) in a read-only session. Up to <C>max_rows</C>{' '}rows (default 200, at most 1,000), a truncated flag, a 30-second limit, sensitive columns masked. PostgreSQL, MySQL/MariaDB, SQLite and ClickHouse.</>],
              [<C key="4">propose_change</C>, 'Propose', <>One INSERT, UPDATE, DELETE or DDL statement with a one-sentence summary. Nothing runs until you approve it in Plasma. Only works on the connection currently open in Plasma.</>],
              [<C key="5">check_proposal</C>, 'Any', <>Reports what became of a proposal: <C>waiting_for_approval</C>, <C>applied</C>, <C>declined</C>, <C>failed</C>{' '}or <C>expired</C>. Waits up to 45 seconds for you.</>],
              [<C key="6">get_memory</C>, 'Structure', 'Your database memory notes for the connection, so the tool reads your business rules before it writes SQL.'],
              [<C key="7">remember</C>, 'Read queries', 'Proposes a note (up to 500 characters). You review and may edit it in Plasma before it is saved.'],
            ]}
          />
        </>
      ),
      subs: [
        {
          id: 'approvals',
          title: 'Approvals and check_proposal',
          body: (
            <>
              <P>
                When a tool calls <C>propose_change</C>{' '}(or <C>remember</C>), Plasma brings its window forward and shows a card in the
                Assistant panel, in a thread labelled with the client&rsquo;s name. It is the same card as the in-app agent&rsquo;s: you
                read the statement and summary, then approve or reject. On PostgreSQL, approving previews the change with Safe Run first.
                The change goes through all the usual gates: read-only, Prod confirmation and Safe mode.
              </P>
              <UL>
                <LI>
                  <C>propose_change</C>{' '}waits up to 45 seconds for your answer and then replies{' '}
                  <C>waiting_for_approval</C>. The tool is told to keep calling <C>check_proposal</C>{' '}with the id until the answer is no longer
                  waiting, and never to propose the same change twice.
                </LI>
                <LI>
                  An undecided proposal is withdrawn after 10 minutes (status <C>expired</C>). Plasma keeps at most 5 proposals waiting at once.
                  A settled proposal&rsquo;s outcome stays available for an hour.
                </LI>
                <LI>
                  A change can only target the connection that is open in Plasma right now, and it must be a SQL connection. If it is not
                  open, the tool is told to ask you to open it.
                </LI>
              </UL>
            </>
          ),
        },
        {
          id: 'limits',
          title: 'Limits',
          body: (
            <UL>
              <LI>Up to 4 calls are handled at once; a request body is capped at 1,000,000 bytes.</LI>
              <LI>
                Queries run on a separate read-only connection, not on your editor&rsquo;s session.
              </LI>
              <LI>Structure is cached for 60 seconds. Error messages have the host, user, password and database path scrubbed out.</LI>
              <LI>
                Redis and OpenSearch connections can be listed and carry notes, but their data is not queryable through MCP yet; DuckDB
                connections expose their structure but are not queryable through <C>run_query</C>{' '}either.
              </LI>
            </UL>
          ),
        },
      ],
    },
    {
      id: 'masking',
      title: 'Masking',
      body: (
        <P>
          Results from <C>run_query</C>{' '}are masked <B>always</B>, whether or not presentation mode is on. Plasma masks emails, phone numbers,
          card numbers, IP addresses and columns whose names look sensitive, using the connection&rsquo;s own column rules and your{' '}
          <UI>Masking style</UI>; passwords and secrets are fully masked. The one exception is the connection&rsquo;s{' '}
          <UI>Send unmasked values to MCP clients</UI>{' '}switch.
        </P>
      ),
    },
    {
      id: 'security',
      title: 'Security model',
      body: (
        <>
          <UL>
            <LI>
              <B>Loopback only.</B>{' '}The server binds to <C>127.0.0.1</C>{' '}and answers only <C>POST /mcp</C>. The <C>Host</C>{' '}header must be{' '}
              <C>127.0.0.1:&lt;port&gt;</C>{' '}or <C>localhost:&lt;port&gt;</C>, which blocks DNS-rebinding.
            </LI>
            <LI>
              <B>No browsers.</B>{' '}Any request that carries an <C>Origin</C>{' '}header is rejected with 403. Browsers always send one on
              cross-site requests; local MCP clients do not.
            </LI>
            <LI>
              <B>Bearer token.</B>{' '}Every request needs <C>Authorization: Bearer &lt;token&gt;</C>, compared in constant time before the body
              is read. The token is a random 256-bit value, shown masked in Settings with <UI>Show</UI>, <UI>Copy</UI>{' '}and{' '}
              <UI>Regenerate</UI>; regenerating takes effect at once and stops clients that hold the old one. It is stored in a file in
              Plasma&rsquo;s folder that only your user can read (mode 0600 where the system has file modes) so the stdio bridge can read it.
            </LI>
            <LI>
              <B>Least data.</B>{' '}Tools see only the connections you allowed, and results are masked, capped and scrubbed as above.
            </LI>
            <LI>
              <B>No silent writes.</B>{' '}There is no tool that writes without an approval card.
            </LI>
          </UL>
        </>
      ),
    },
    {
      id: 'activity',
      title: 'Activity log and audit',
      body: (
        <>
          <P>
            The bottom of the MCP section lists the last 50 calls: time, client, tool, connection and outcome (<UI>Done</UI>,{' '}
            <UI>Failed</UI>, <UI>Declined</UI>{' '}or <UI>Refused</UI>).
          </P>
          <P>
            Every tool call is also written to the tamper-evident <Doc to="safety-privacy#audit-log">audit log</Doc>, on every connection,
            with the source <UI>MCP tool</UI>. An entry holds the client and tool name, the SQL (cut at 2,000 characters), the outcome, row
            count and duration; the database user is never recorded for MCP calls.
          </P>
        </>
      ),
    },
  ],
};
