import { Callout } from '@/components/docs/callout';
import { CodeBlock } from '@/components/docs/code-block';
import { DocTable } from '@/components/docs/doc-table';
import { B, C, Doc, LI, P, UI, UL } from '@/components/docs/prose';
import type { DocPage } from './types';

export const connections: DocPage = {
  slug: 'connections',
  title: 'Connections',
  group: 'Connections',
  summary:
    'Seven engines, URLs, SSH tunnels, TLS, read-only and Prod tags, the connection test with its plain-language diagnosis, team workspaces and where passwords are kept.',
  sections: [
    {
      id: 'engines',
      title: 'Engines and defaults',
      body: (
        <>
          <DocTable
            head={['Engine', 'Default port', 'URL schemes', 'Notes']}
            rows={[
              ['PostgreSQL', '5432', <><C>postgres://</C>, <C>postgresql://</C></>, 'Default user postgres, default database postgres.'],
              ['MySQL · MariaDB', '3306', <><C>mysql://</C>, <C>mariadb://</C></>, 'Default user root. The database is optional.'],
              ['SQLite', 'a local file', '', 'Pick or create a file. No network, login or tunnel.'],
              ['ClickHouse', '8123 (HTTP)', <C key="ch">clickhouse://</C>, 'Over HTTP or HTTPS. Default user default, database default.'],
              ['DuckDB', 'local files', '', 'A .duckdb file (opened read-only) or data files. See the DuckDB page.'],
              ['Redis', '6379', <><C>redis://</C>, <C>rediss://</C>{' '}(TLS)</>, 'Opens database index 0 unless you set another.'],
              ['OpenSearch', '9200', <><C>https://</C>, <C>http://</C>, <C>opensearch://</C></>, 'HTTP or HTTPS. Default port 9200.'],
            ]}
          />
        </>
      ),
    },
    {
      id: 'new-connection',
      title: 'Creating a connection',
      body: (
        <>
          <P>
            <UI>New connection</UI>{' '}opens <UI>Add a connection</UI>: paste a URL or pick an engine. Inside the form,{' '}
            <UI>Import URL…</UI>{' '}(top right of the Connection card) fills the fields from a URL you paste and click{' '}
            <UI>Apply</UI>{' '}on. A saved connection can be copied with the copy-URL button, which never includes the
            password. The engine of a saved connection is fixed; to change it, delete and add again.
          </P>
        </>
      ),
      subs: [
        {
          id: 'url-format',
          title: 'Connection URLs',
          body: (
            <>
              <CodeBlock
                label="Examples"
                code={[
                  'postgres://user:pass@host:5432/db?sslmode=verify-full',
                  'mysql://user:pass@host:3306/db?sslmode=verify-full',
                  'clickhouse://user:pass@host:8123/default',
                  'redis://user:pass@host:6379/0',
                  'rediss://user:pass@host:6380/0',
                  'https://user:pass@search.example.com:9200',
                ].join('\n')}
              />
              <UL>
                <LI>
                  A missing port becomes the engine&rsquo;s default. The password may be in the URL (percent-encode special
                  characters); it lands in the password field.
                </LI>
                <LI>
                  <C>?sslmode=</C>{' '}accepts <C>disable</C>, <C>prefer</C>, <C>allow</C>{' '}(treated as <C>prefer</C>),{' '}
                  <C>require</C>, <C>verify-ca</C>{' '}and <C>verify-full</C>. Anything else is an error.
                </LI>
                <LI>
                  <C>rediss://</C>, <C>https://</C>{' '}and <C>?ssl=true</C>{' '}turn TLS on with <C>verify-full</C>{' '}unless a
                  mode is given.
                </LI>
                <LI>
                  Postgres also reads <C>?dbname=</C>, MySQL and ClickHouse <C>?database=</C>, Redis <C>?db=</C>, and all
                  accept <C>?user=</C>{' '}and <C>?password=</C>{' '}when the URL has no userinfo.
                </LI>
              </UL>
            </>
          ),
        },
        {
          id: 'fields',
          title: 'The form, card by card',
          body: (
            <>
              <DocTable
                head={['Card', 'What is in it']}
                rows={[
                  [
                    'Connection',
                    <>
                      <UI>Name</UI>, <UI>Folder (optional)</UI>{' '}(connections are grouped by folder in the list),{' '}
                      <UI>Environment</UI>{' '}(Local, Dev, Staging, Prod) and the <UI>Read-only</UI>{' '}switch.
                    </>,
                  ],
                  [
                    'Server',
                    <>
                      <UI>Host</UI>, <UI>Port</UI>, <UI>Database</UI>{' '}(Redis: <UI>DB index</UI>). For a file engine:{' '}
                      <UI>Open…</UI>{' '}and (SQLite only) <UI>New…</UI>.
                    </>,
                  ],
                  [
                    'Authentication',
                    <>
                      <UI>User</UI>{' '}and <UI>Password</UI>{' '}(Redis: <UI>ACL user (optional)</UI>). OpenSearch adds a{' '}
                      <UI>Method</UI>: username and password, API key, or AWS SigV4.
                    </>,
                  ],
                  [
                    'Security',
                    <>
                      The TLS mode (see below) and the <UI>CA certificate</UI>, <UI>Client certificate</UI>{' '}and{' '}
                      <UI>Client key</UI>{' '}file pickers.
                    </>,
                  ],
                  ['SSH tunnel', 'A switch, then the bastion host and how to log in.'],
                  [
                    'Advanced',
                    <>
                      <UI>Safe mode</UI>, <UI>Always Safe Run writes</UI>{' '}and <UI>Run after connecting (SQL)</UI>{' '}(the last
                      two for Postgres).
                    </>,
                  ],
                ]}
              />
              <P>
                Editing a saved connection never shows its password. The field reads &ldquo;Saved &mdash; leave blank to
                keep&rdquo;; type a new one to replace it.
              </P>
            </>
          ),
        },
        {
          id: 'redis-hosts',
          title: 'Redis hosts: sockets, Sentinel, Cluster',
          body: (
            <>
              <P>The Redis <UI>Host</UI>{' '}field accepts more than a name.</P>
              <UL>
                <LI>A unix socket path (starts with <C>/</C>{' '}or <C>unix:</C>): the port is ignored.</LI>
                <LI>
                  <C>sentinel://host1:26379,host2:26379/master-name</C>
                </LI>
                <LI>
                  <C>cluster://host1:7000,host2:7001</C>{' '}(seed nodes)
                </LI>
              </UL>
            </>
          ),
        },
        {
          id: 'opensearch-fields',
          title: 'OpenSearch fields',
          body: (
            <UL>
              <LI>
                <UI>Path prefix (optional)</UI>{' '}for a cluster behind a reverse proxy (for example <C>/search</C>).
              </LI>
              <LI>
                <UI>Additional nodes (optional)</UI>, one per line, as <C>node2.example.com:9200</C>{' '}or{' '}
                <C>https://node3:9200</C>.
              </LI>
              <LI>
                Authentication methods: <UI>Username and password</UI>{' '}(leave both empty for an open cluster),{' '}
                <UI>API key</UI>{' '}(<C>id:key</C>{' '}or base64) and <UI>AWS SigV4 (Amazon OpenSearch)</UI>{' '}with region,
                service (<UI>Managed domain (es)</UI>{' '}or <UI>Serverless (aoss)</UI>), access key id, secret access key
                and an optional session token.
              </LI>
            </UL>
          ),
        },
      ],
    },
    {
      id: 'tls',
      title: 'TLS and certificates',
      body: (
        <>
          <P>
            The Security card has one mode selector. Its label is <UI>SSL mode</UI>{' '}for PostgreSQL and MySQL,{' '}
            <UI>TLS</UI>{' '}for Redis and <UI>HTTPS</UI>{' '}for ClickHouse and OpenSearch.
          </P>
          <DocTable
            head={['Mode', 'Meaning']}
            rows={[
              ['Disabled', 'No encryption.'],
              ['Preferred', 'PostgreSQL only. Encrypt if the server supports it; the certificate is not checked.'],
              ['Required (no verification)', 'Encrypted, but the server certificate is not checked.'],
              ['Verify CA', 'The certificate must be signed by a trusted CA (the system trust store, or the CA file you choose).'],
              ['Verify CA and host name', 'As Verify CA, and the certificate must name the host you typed.'],
            ]}
          />
          <Callout kind="warning" title="Prod and unverified TLS">
            The form states that the modes without certificate checking are <B>not allowed for connections tagged Prod</B>.
          </Callout>
          <P>
            Pick <UI>CA certificate</UI>{' '}to trust a private CA, and <UI>Client certificate</UI>{' '}plus{' '}
            <UI>Client key</UI>{' '}for mutual TLS. A client certificate needs its key and the other way round.
          </P>
        </>
      ),
    },
    {
      id: 'ssh',
      title: 'SSH tunnels',
      body: (
        <>
          <P>
            Switch on <UI>Connect over SSH tunnel</UI>{' '}in the SSH tunnel card to reach a database on a private network
            through a bastion host. Fill <UI>SSH host</UI>, <UI>SSH port</UI>{' '}(default 22) and <UI>SSH user</UI>, then give
            at least one way to log in:
          </P>
          <UL>
            <LI>
              <UI>SSH private key</UI>: paste the key text (it takes priority over a password), with a{' '}
              <UI>Key passphrase</UI>{' '}if it has one;
            </LI>
            <LI>
              <UI>SSH key file</UI>: a path such as <C>~/.ssh/id_ed25519</C>, used when no key is pasted;
            </LI>
            <LI>
              <UI>Use the ssh-agent (SSH_AUTH_SOCK)</UI>{' '}(on Windows Plasma looks for Pageant or the OpenSSH pipe);
            </LI>
            <LI>
              <UI>SSH password</UI>.
            </LI>
          </UL>
          <P>
            Plasma tries every method you set. The first time it reaches a bastion it shows the host key&rsquo;s SHA256
            fingerprint and asks you to verify it with the server&rsquo;s administrator: <UI>Trust and connect</UI>{' '}or{' '}
            <UI>Cancel</UI>. If a host you trusted before presents a different key, the dialog warns that the server
            may have been reinstalled <em>or that someone is intercepting the connection</em>, and the buttons become{' '}
            <UI>Cancel connection</UI>{' '}and <UI>Trust the new key</UI>.
          </P>
          <Callout kind="note" title="Where tunnels are not available">
            SSH tunnels are not offered for OpenSearch, SQLite or DuckDB. For Redis a tunnel forwards one TCP address, so
            it cannot be used with a unix socket, a <C>sentinel://</C>{' '}host or a <C>cluster://</C>{' '}host; the form says why.
          </Callout>
        </>
      ),
    },
    {
      id: 'tags-readonly',
      title: 'Read-only, tags and the Prod gate',
      body: (
        <>
          <P>
            These two settings are the first line of defence, and both live on the Connection card.
          </P>
        </>
      ),
      subs: [
        {
          id: 'read-only',
          title: 'Read-only',
          body: (
            <P>
              <UI>Read-only</UI>{' '}&ldquo;refuses writes on every engine&rdquo;. It is enforced as close to the engine as
              the engine allows: for PostgreSQL the session is set read-only and re-asserted before every statement,
              MySQL does the same, ClickHouse uses its <C>readonly=1</C>{' '}mode, SQLite opens the file read-only, and
              DuckDB opens <C>.duckdb</C>{' '}files read-only. Redis and OpenSearch have no such switch, so Plasma classifies
              each command and request and refuses writes in the app itself. Grid edits and the write buttons are also
              disabled. A statement cannot undo it: SQL that tries to switch read-only off is refused.
            </P>
          ),
        },
        {
          id: 'env-tags',
          title: 'Environment tags and Prod',
          body: (
            <>
              <P>
                Tag a connection <UI>Local</UI>, <UI>Dev</UI>, <UI>Staging</UI>{' '}or <UI>Prod</UI>. Each has a colour that the
                connection capsule shows, so you always see where you are. Choosing <UI>Prod</UI>{' '}also ticks Read-only
                (you can untick it). What Prod changes:
              </P>
              <UL>
                <LI>the connection capsule in the top bar turns red;</LI>
                <LI>destructive SQL always asks first, whatever the Safe mode level;</LI>
                <LI>
                  every statement run on it is written to the <Doc to="safety-privacy#audit-log">audit log</Doc>;
                </LI>
                <LI>
                  <UI>Always Safe Run writes</UI>{' '}is on by default on Postgres;
                </LI>
                <LI>every write from the Redis CLI and from OpenSearch asks first;</LI>
                <LI>
                  the AI assistant sends the schema only after you opt in for that connection (see{' '}
                  <Doc to="ai-assistant#what-is-sent">what is sent</Doc>);
                </LI>
                <LI>unverified TLS modes are not allowed.</LI>
              </UL>
            </>
          ),
        },
        {
          id: 'safe-mode-conn',
          title: 'Safe mode per connection',
          body: (
            <P>
              <UI>Advanced</UI>{' '}&rarr; <UI>Safe mode</UI>{' '}overrides the app-wide default for this one connection. The
              levels are described on <Doc to="safety-privacy#safe-mode">Safety and privacy</Doc>.
            </P>
          ),
        },
      ],
    },
    {
      id: 'test',
      title: 'Test, errors and diagnosis',
      body: (
        <>
          <P>
            <UI>Test</UI>{' '}shows the steps it went through, in order: <UI>Open the SSH tunnel</UI>{' '}(when one is set),{' '}
            <UI>Find the host</UI>, <UI>Reach the port</UI>, <UI>Set up TLS</UI>, <UI>Log in</UI>, and last{' '}
            <UI>Open the database</UI>{' '}(Redis: <UI>Select the database</UI>; OpenSearch: <UI>Check the cluster</UI>; a
            file: <UI>Open the file</UI>). It stops at the first step that fails and marks the rest as skipped. Each step
            shows how long it took.
          </P>
          <P>
            A failure is turned into a title, a short explanation and the likely fixes, with the offending field
            highlighted. A <UI>Copy the error details</UI>{' '}button copies the diagnosis; secrets are removed from it first.
            These are the problems Plasma recognises:
          </P>
          <DocTable
            head={['Area', 'Messages you may see']}
            rows={[
              ['Network', 'Host not found; The name server did not answer; Nothing is listening there; The server did not answer; No route to the server; That does not look like <engine>'],
              ['TLS', 'The server requires TLS; The server does not support TLS; The server’s certificate is not trusted; The certificate is for a different host name; The server’s certificate has expired; The TLS handshake failed'],
              ['Login', 'No password was sent; Login was refused; The login method is not supported; The server does not allow this login from here'],
              ['Database', 'Database not found; No permission to open this database; The server has no free connections; The server is not ready yet'],
              ['Redis', 'This Redis needs a password; Redis refused the login; This Redis user lacks permissions; No such Redis database; Redis closed the connection'],
              ['OpenSearch', 'OpenSearch refused the login (401); This user may not use the cluster (403); The cluster is not ready (503); The cluster is red'],
              ['SSH', 'The SSH host key was not accepted; SSH login failed; The SSH key could not be used; The SSH host could not be reached; The SSH host did not answer; The jump host could not reach the database'],
              ['Files', 'File not found; That is not a SQLite (or DuckDB) database; The file cannot be opened'],
            ]}
          />
          <P>Anything else is shown as <UI>Could not connect</UI>{' '}with the server&rsquo;s own message.</P>
        </>
      ),
    },
    {
      id: 'managing',
      title: 'Saved connections',
      body: (
        <UL>
          <LI>
            The list is searchable (<UI>Search connections…</UI>) and grouped by <UI>Folder</UI>. In the editor,{' '}
            <UI>Duplicate</UI>{' '}copies a connection and <UI>Delete</UI>{' '}asks <UI>Delete connection?</UI>{' '}first.
          </LI>
          <LI>
            On the Connections home each card has <UI>Edit</UI>, <UI>Duplicate</UI>{' '}and <UI>Allow AI tools…</UI>, the last
            of which opens Settings at the <Doc to="mcp-server">MCP server</Doc>{' '}section.
          </LI>
          <LI>
            The switcher in the top bar changes connection (or database) from anywhere, and holds{' '}
            <UI>Reconnect to …</UI>, <UI>Disconnect from …</UI>{' '}and <UI>New connection…</UI>. Disconnecting with staged
            grid edits asks first.
          </LI>
          <LI>
            <UI>Settings</UI>{' '}&rarr; <UI>General</UI>{' '}can reconnect to your last connection on launch and retry
            automatically after a lost connection (see <Doc to="reliability#reconnect">Reconnecting</Doc>).
          </LI>
        </UL>
      ),
    },
    {
      id: 'passwords',
      title: 'Where passwords are stored',
      body: (
        <>
          <P>
            Database passwords, SSH passwords and keys, OpenSearch keys and your AI API key are encrypted with the
            operating system&rsquo;s secret store (macOS Keychain, Windows Credential Vault, or GNOME Keyring or KWallet
            on Linux) and stored as ciphertext in Plasma&rsquo;s local database. The renderer process never receives a
            saved password back. If the system has no working secret store, Plasma refuses to save connections rather than
            store a password in the clear. More on{' '}
            <Doc to="safety-privacy#secrets">Safety and privacy</Doc>.
          </P>
        </>
      ),
    },
    {
      id: 'workspaces',
      title: 'Team workspaces',
      body: (
        <>
          <P>
            A workspace is a folder you can commit to git. It holds a <C>.plasma/</C>{' '}directory with shared connection
            profiles, saved queries, snippets and notebooks. Open one with <UI>Open workspace folder…</UI>{' '}(File menu,
            the Connections home, or the command palette), or with <C>plasma open &lt;folder&gt;</C>. The home also lists{' '}
            <UI>Recent workspaces</UI>, each with a forget button, and a workspace section in the sidebar has a close
            button.
          </P>
          <DocTable
            head={['Path', 'Holds']}
            rows={[
              [<C key="a">.plasma/connections.json</C>, 'Connection profiles. Never a password.'],
              [<C key="b">.plasma/queries/**/*.sql</C>, 'Saved queries; folders are groups. A short comment header stores the name, description, connection and variables.'],
              [<C key="c">.plasma/snippets.json</C>, 'Editor snippets.'],
              [<C key="d">.plasma/notebooks/*.plasma-notebook.json</C>, 'Notebooks.'],
            ]}
          />
          <P>
            Files are written in a fixed, sorted order with no timestamps, so saving an unchanged item produces an
            identical file and a diff shows only real edits.
          </P>
        </>
      ),
      subs: [
        {
          id: 'profiles',
          title: 'Profiles, environment variables and passwords',
          body: (
            <>
              <P>
                A profile has an id, name, engine, host, port, database, user, TLS settings, read-only flag, tag, folder
                and optional start-up SQL. A profile that contains a <C>password</C>{' '}key is skipped with a message. Text
                fields may use <C>{'${NAME}'}</C>{' '}or <C>{'${NAME:-default}'}</C>, replaced from the environment Plasma runs
                in (nothing else is read, and a missing variable without a default is an error); write <C>$$</C>{' '}for a
                literal dollar sign.
              </P>
              <CodeBlock
                label=".plasma/connections.json"
                code={JSON.stringify(
                  {
                    version: 1,
                    connections: [
                      { id: 'shop-staging', name: 'Shop (staging)', engine: 'postgres', tag: 'staging', host: '${SHOP_DB_HOST}', port: 5432, database: 'shop', user: '${SHOP_DB_USER:-app}', tlsMode: 'verify-full', readOnly: true },
                    ],
                  },
                  null,
                  2,
                )}
              />
              <P>
                The first time you use a profile, Plasma asks for its password (&ldquo;Leave empty to connect without a
                password&rdquo;). It is kept in your OS keychain for that workspace and is never written to the folder.
              </P>
            </>
          ),
        },
        {
          id: 'workspace-queries',
          title: 'Saving queries to the workspace',
          body: (
            <P>
              <UI>Save current query to workspace</UI>{' '}(in the workspace section) asks for a <UI>Name</UI>, an optional{' '}
              <UI>Folder</UI>{' '}and a <UI>Description</UI>. Pressing <Doc to="shortcuts">Save</Doc>{' '}on a tab that came from
              the workspace writes back to its file. If the file changed on disk meanwhile (a teammate, git or another
              editor), Plasma asks before it overwrites: <UI>File changed on disk</UI>, <UI>Overwrite</UI>. Opening a
              workspace notebook over a notebook draft you already have asks <UI>Replace your notebook?</UI>.
            </P>
          ),
        },
        {
          id: 'workspace-limits',
          title: 'Limits',
          body: (
            <P>
              A workspace is read up to 2,000 files, and a single file larger than 1 MiB is ignored, so a huge repository
              cannot stall the app.
            </P>
          ),
        },
      ],
    },
  ],
};
