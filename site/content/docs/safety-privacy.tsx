import { Callout } from '@/components/docs/callout';
import { DocTable } from '@/components/docs/doc-table';
import { Shot } from '@/components/docs/figure';
import { B, C, Doc, LI, P, UI, UL } from '@/components/docs/prose';
import type { DocPage } from './types';

export const safetyPrivacy: DocPage = {
  slug: 'safety-privacy',
  title: 'Safety and privacy',
  group: 'Safety and reliability',
  summary:
    'The guards between you and a bad statement, what the audit log records, how secrets are stored, and an exact list of what leaves your machine and when.',
  sections: [
    {
      id: 'layers',
      title: 'The guards, in order',
      body: (
        <>
          <P>
            No single switch makes a database safe, so Plasma stacks several. From outermost to innermost:
          </P>
          <DocTable
            head={['Guard', 'What it does']}
            rows={[
              [<Doc key="a" to="safety-privacy#read-only">Read-only connection</Doc>, 'Refuses every write on every engine.'],
              [<Doc key="b" to="safety-privacy#prod-gate">Prod tag</Doc>, 'Destructive SQL always asks; writes on Redis and OpenSearch ask; every statement is audited.'],
              [<Doc key="c" to="safety-privacy#safe-mode">Safe mode</Doc>, 'Asks before dangerous statements, every write, or every statement, or refuses writes.'],
              [<Doc key="d" to="sql-editor#safe-run">Safe Run</Doc>, 'Shows the exact rows a write, or a script of up to 20 writes, changes before you commit it.'],
              [<Doc key="e" to="results#editing">Staged edits</Doc>, 'Grid changes wait for an explicit Commit, in one transaction.'],
              [<Doc key="f" to="results#conflicts">Conflict detection</Doc>, 'A commit does not overwrite a row someone else changed.'],
              [<Doc key="g" to="safety-privacy#audit-log">Audit log</Doc>, 'A tamper-evident record of what ran.'],
            ]}
          />
          <Shot k="guard-confirm" caption="Safe mode asks before a DROP TABLE runs." />
        </>
      ),
    },
    {
      id: 'safe-mode',
      title: 'Safe mode',
      body: (
        <>
          <P>
            Safe mode is a confirmation level for the SQL you run from the editor, the grid commit and the actions that write on your
            behalf. Set the default in <UI>Settings</UI>{' '}&rarr; <UI>Security</UI>{' '}&rarr; <UI>Safe mode</UI>{' '}(the default level is{' '}
            <UI>Confirm dangerous statements</UI>), and override it per connection in <UI>Advanced</UI>.
          </P>
          <DocTable
            head={['Level', 'Behaviour']}
            rows={[
              ['Off', 'Run everything without asking.'],
              ['Confirm dangerous statements', 'DROP, TRUNCATE, DELETE and UPDATE without WHERE ask first.'],
              ['Confirm every write', 'Any statement that may write asks first.'],
              ['Confirm every statement', 'Every statement asks first.'],
              ['Read-only', 'Statements that write are refused. Session statements (SET, BEGIN, COMMIT, …) still run.'],
            ]}
          />
          <UL>
            <LI>
              <B>What counts as dangerous:</B> <C>DROP</C>, <C>TRUNCATE</C>, <C>DELETE</C>, an <C>UPDATE</C>{' '}without <C>WHERE</C>,{' '}
              <C>ALTER … DROP</C>{' '}or <C>RENAME</C>, <C>MERGE</C>, <C>DO</C>{' '}blocks, <C>CALL</C>, <C>COPY … FROM</C>,{' '}
              <C>INSERT … ON CONFLICT DO UPDATE</C>{' '}and data-changing CTEs. <C>EXPLAIN ANALYZE</C>{' '}counts as its target statement. It is a
              heuristic, not a parser: a false positive only costs an extra confirmation.
            </LI>
            <LI>
              <B>Functions with side effects</B>{' '}(such as <C>nextval</C>, <C>set_config</C>, <C>pg_terminate_backend</C>, advisory locks and{' '}
              <C>pg_notify</C>) count as writes. At the Read-only level, a <C>SELECT</C>{' '}that calls a function Plasma cannot vouch for asks
              first, because it might write.
            </LI>
            <LI>
              The dialog is titled <UI>Run this statement?</UI>{' '}and names the connection; it points to the connection&rsquo;s Advanced
              settings to change the level. For a grid commit it reads <UI>Commit changes?</UI>.
            </LI>
            <LI>
              Statements that a refused level blocks come back with a message saying Safe mode is read-only for the connection.
            </LI>
          </UL>
        </>
      ),
    },
    {
      id: 'prod-gate',
      title: 'The Prod gate',
      body: (
        <>
          <P>
            Tag a connection <UI>Prod</UI>{' '}(<Doc to="connections#env-tags">Connections</Doc>) and it gets a stricter set of rules on top
            of Safe mode, whatever the level:
          </P>
          <UL>
            <LI>
              A destructive statement or a grid commit asks first. The dialog reads <UI>Run destructive query on production?</UI>{' '}(or{' '}
              <UI>Commit changes to production?</UI>), reminds you to verify your <C>WHERE</C>{' '}clause, and its confirm button is{' '}
              <UI>Run anyway</UI>{' '}(<UI>Commit</UI>).
            </LI>
            <LI>The connection capsule in the top bar turns red so you cannot forget where you are.</LI>
            <LI>Read-only is suggested when you pick the tag.</LI>
            <LI>
              Safe Run is on for writes by default; Redis CLI writes and OpenSearch writes ask; deleting Redis keys by pattern needs the count
              typed in.
            </LI>
            <LI>The audit log records every statement on it.</LI>
            <LI>The AI assistant sends no schema until you opt that connection in; unverified TLS is not allowed.</LI>
          </UL>
          <P>
            A ClickHouse mutation (<C>ALTER TABLE … UPDATE</C>{' '}and similar) gets its own confirmation, <UI>Run an asynchronous mutation?</UI>,
            because it cannot be rolled back.
          </P>
        </>
      ),
    },
    {
      id: 'read-only',
      title: 'Read-only, enforced where the engine allows',
      body: (
        <>
          <P>
            The <UI>Read-only</UI>{' '}switch is not just a greyed-out button. The main process classifies every request and refuses writes
            (including grid commits, DDL, imports, restores, Redis writes, OpenSearch index and document changes, <C>pg_notify</C>{' '}and Safe
            Run) before they reach a driver, and the engines add their own enforcement:
          </P>
          <DocTable
            head={['Engine', 'Enforced by']}
            rows={[
              ['PostgreSQL', 'The session is read-only and re-asserted before every statement, with a screen for statements that try to switch it off.'],
              ['MySQL / MariaDB', 'A read-only session transaction, re-asserted before every statement, with a screen for READ WRITE and similar.'],
              ['SQLite', 'A read-only file handle plus query_only.'],
              ['ClickHouse', 'The server setting readonly=1, which the server refuses to lift.'],
              ['DuckDB', 'A .duckdb file is opened read-only.'],
              ['Redis', 'Every command is classified; anything not known to be a read is a write and is refused.'],
              ['OpenSearch', 'Every request is classified; only known reads are allowed, including the SQL plugin, where the statement decides.'],
            ]}
          />
        </>
      ),
    },
    {
      id: 'other-confirms',
      title: 'Other places Plasma stops to ask',
      body: (
        <UL>
          <LI>
            <B>Closing a tab with unsaved SQL</B>: <UI>Close &ldquo;…&rdquo; without saving?</UI>; with staged edits, <UI>Discard N changes?</UI>
          </LI>
          <LI>
            <B>Switching or disconnecting with staged edits</B>: <UI>Uncommitted edits</UI>, with <UI>Cancel</UI>, <UI>Discard</UI>{' '}and{' '}
            <UI>Commit</UI>.
          </LI>
          <LI>
            <B>Quitting the window with unsaved work</B>: <UI>Close Plasma and discard your work?</UI>, with <UI>Cancel</UI>{' '}and{' '}
            <UI>Discard and close</UI>.
          </LI>
          <LI>
            <B>Dropping and truncating objects</B>{' '}show the exact statement and a CASCADE option first.
          </LI>
          <LI>
            <B>Restart to update</B>{' '}lists what the restart would lose.
          </LI>
        </UL>
      ),
    },
    {
      id: 'audit-log',
      title: 'Audit log',
      body: (
        <>
          <P>
            Open <UI>History</UI>{' '}and switch to <UI>Audit</UI>. Plasma appends a row for every statement run on a Prod-tagged connection;
            turn on <UI>Settings</UI>{' '}&rarr; <UI>Security</UI>{' '}&rarr; <UI>Record every connection, not only Prod</UI>{' '}to include all of them.
            Each row has the time, connection, database user, source, outcome, row count, duration and the statement. The source says where
            the statement came from: <UI>Editor</UI>, <UI>Grid commit</UI>, <UI>Safe Run</UI>, <UI>Structure</UI>, <UI>Import</UI>,{' '}
            <UI>AI suggestion</UI>, <UI>NOTIFY</UI>{' '}or <UI>MCP tool</UI>.
          </P>
          <UL>
            <LI>
              <B>Redacted.</B>{' '}Statements and error text go through the same redactor as the query history: <C>PASSWORD &apos;…&apos;</C>{' '}
              literals and <C>password=</C>{' '}values are masked, and error text drops the values it quotes.
            </LI>
            <LI>
              <B>Append-only and chained.</B>{' '}The table refuses updates and deletes, and each row stores a SHA-256 hash of its fields plus
              the previous row&rsquo;s hash. <UI>Verify log integrity</UI>{' '}replays the chain and tells you if a row in the middle was edited or
              removed. This is tamper <em>evidence</em>, not tamper proofing: someone with access to the database file could rewrite the whole
              chain.
            </LI>
            <LI>
              <B>Retention.</B>{' '}Entries older than <UI>Audit retention</UI>{' '}(30, 90, 180, 365 or 1,095 days; default 90) are removed, and the
              remaining log still verifies.
            </LI>
            <LI>
              <B>Filter and export.</B>{' '}Search statements, users and errors; filter by connection, outcome and date range; export <UI>CSV</UI>{' '}or{' '}
              <UI>JSON</UI>.
            </LI>
          </UL>
        </>
      ),
    },
    {
      id: 'masking',
      title: 'Masking',
      body: (
        <P>
          Presentation mode masks sensitive values on screen, in the clipboard and in the AI context; the MCP server always masks. See{' '}
          <Doc to="results#presentation">Presentation mode and masking</Doc>. Masking is display only: stored data and the values used for edits
          do not change.
        </P>
      ),
    },
    {
      id: 'secrets',
      title: 'Where secrets are stored',
      body: (
        <>
          <UL>
            <LI>
              Database passwords, SSH passwords, keys and passphrases, OpenSearch credentials and the AI API key are encrypted with the
              operating system&rsquo;s secret store through Electron&rsquo;s <C>safeStorage</C>{' '}(macOS Keychain, Windows Credential Vault, or{' '}
              libsecret / GNOME Keyring / KWallet on Linux). The ciphertext sits in Plasma&rsquo;s local database; the interface process never
              receives a saved password back.
            </LI>
            <LI>
              If the system has no usable secret store, Plasma refuses to save secrets. On Linux with no keyring it asks at startup:{' '}
              <UI>Don&rsquo;t store secrets</UI>{' '}or <UI>Store with weak protection</UI>, the second meaning a fixed fallback key that every program on
              the computer knows. Choosing weak protection is remembered; declining is asked again at the next launch. Installing and unlocking a keyring, then restarting, is the better answer.
            </LI>
            <LI>
              Team workspaces never hold passwords: a profile that contains one is skipped. The password you type for a workspace connection goes to
              your keychain.
            </LI>
            <LI>
              The MCP token is the exception: the stdio bridge has to read it, so it lives in a file in Plasma&rsquo;s folder that only your user can
              read (mode 0600 where the system has file modes).
            </LI>
            <LI>
              Logs and the support bundle remove secrets and never include query results, SQL you wrote, or row data.
            </LI>
          </UL>
          <Callout kind="note" title="What encryption does not cover">
            Everything else Plasma stores is not secret-encrypted: preferences, connection names and hosts, query history, saved queries, snippets,
            notebook drafts, schema snapshots and memory notes sit in the local database as ordinary data. Plasma redacts passwords from history
            and the audit log, but SQL you type is kept.
          </Callout>
        </>
      ),
    },
    {
      id: 'leaves-machine',
      title: 'What leaves your machine, and when',
      body: (
        <>
          <P>
            Plasma has no account system and no usage analytics or crash-report upload. Beyond the databases you connect to, it talks to the network
            in these cases only:
          </P>
          <DocTable
            head={['What', 'When', 'Where it goes', 'What it carries']}
            rows={[
              ['Your databases', 'When you connect', 'The hosts you configure, directly or through your SSH bastion', 'Your credentials and queries, as the database protocol requires. TLS as you set it.'],
              ['Update check', 'About 30 seconds after launch, every six hours while Plasma runs, and on Check now', "Plasma's release feed (a Cloudflare R2 bucket), over HTTPS", 'A request for the signed manifest and, if there is a newer version, the installer or archive. No data from your databases.'],
              ['What’s new', 'When you click it', 'Your browser', 'Opens the release notes page.'],
              ['AI assistant, tasks and agent', 'Only when you use an AI feature, and only if you configured a provider', 'OpenRouter (and onward to the model vendor), or the local server you named', 'The items in What is sent. See the AI page.'],
              ['Model list', 'When a model picker is shown (the Assistant message box or Settings → AI), even before you add a key', 'OpenRouter (or your local server)', 'A request for the public model list, with no key and none of your data. The OpenRouter list is cached on disk for six hours; a local server is asked each time.'],
              ['DuckDB extensions', 'Only if you agree, the first time you open Excel files or attach PostgreSQL', 'extensions.duckdb.org', 'A one-time download of a signed extension.'],
              ['MCP server', 'Only if you turn it on', 'Loopback (127.0.0.1) only', 'What your AI tool asks for, as described on the MCP page. Nothing is sent by Plasma to the Internet.'],
              ['Links you click', 'When you click one', 'Your browser', 'GitHub, release notes. Plasma opens only http, https and mailto links.'],
            ]}
          />
          <P>
            The app window can only show the app itself, denies browser permission prompts (camera, location, notifications and so on) and
            sends external links to your operating system&rsquo;s browser.
          </P>
        </>
      ),
    },
  ],
};
