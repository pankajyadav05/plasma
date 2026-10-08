import { Callout } from '@/components/docs/callout';
import { CodeBlock } from '@/components/docs/code-block';
import { B, C, Doc, LI, P, UI, UL } from '@/components/docs/prose';
import type { DocPage } from './types';

export const troubleshooting: DocPage = {
  slug: 'troubleshooting',
  title: 'Troubleshooting and FAQ',
  group: 'Reference',
  summary: 'Fixes for the problems people hit most: first launch, updates, connections, editing, backups, MCP and AI.',
  sections: [
    {
      id: 'launch',
      title: 'Starting Plasma',
      body: (
        <>
          <P>
            <B>macOS says Plasma &ldquo;can&rsquo;t be opened&rdquo;.</B>{' '}The build has no Apple signature yet. Open <UI>System Settings</UI>{' '}&rarr;{' '}
            <UI>Privacy &amp; Security</UI>{' '}and click <UI>Open Anyway</UI>, or clear the quarantine flag:
          </P>
          <CodeBlock label="Terminal" code="xattr -cr /Applications/Plasma.app" />
          <P>
            <B>Windows shows a SmartScreen warning.</B>{' '}The build has no Microsoft signature yet. Click <UI>More info</UI>, then <UI>Run anyway</UI>.
          </P>
          <P>
            <B>Nothing happens when I open a second copy.</B>{' '}Plasma allows one instance per profile. Starting it again brings the running window
            forward, and links and <C>plasma open</C>{' '}commands are handed to that window. To run two profiles side by side, start the second with the{' '}
            <C>PLASMA_USER_DATA</C>{' '}environment variable set to a different folder.
          </P>
          <P>
            <B>On Linux the AppImage prints that it starts without the sandbox.</B>{' '}Your kernel blocks the user namespaces Chromium&rsquo;s sandbox needs
            (common on Ubuntu 24.04 and later). Install the <C>.deb</C>, which ships an AppArmor profile that keeps the sandbox. See{' '}
            <Doc to="install#linux">Linux</Doc>.
          </P>
          <P>
            <B>On Linux Plasma says &ldquo;No system keyring found&rdquo;.</B>{' '}Install and unlock GNOME Keyring or KWallet and restart. Choosing{' '}
            <UI>Store with weak protection</UI>{' '}works, but the key is one every program on the computer knows.
          </P>
          <P>
            <B>macOS asks to allow the keychain item after an update.</B>{' '}Click <UI>Always Allow</UI>. See{' '}
            <Doc to="install#macos">macOS</Doc>.
          </P>
        </>
      ),
    },
    {
      id: 'updates',
      title: 'Updates',
      body: (
        <UL>
          <LI>
            <B>No &ldquo;Restart to update&rdquo; button, only &ldquo;Update&rdquo; or &ldquo;Download&rdquo;.</B>{' '}That install cannot replace itself: a portable
            Windows build, an all-users Windows install, a <C>.deb</C>, or a Mac app running from a disk image or a folder it cannot write to. The button opens
            the download in your browser: the new <C>.dmg</C>{' '}or <C>.deb</C>, or the download page for Windows. On a Mac, move Plasma to <UI>Applications</UI>{' '}to get automatic updates.
          </LI>
          <LI>
            <B>&ldquo;Update refused: …&rdquo;.</B>{' '}Plasma checks a signature and checksums before it installs anything and refused this one. Try <UI>Check
            now</UI>{' '}later; if it persists, download the installer from the site.
          </LI>
          <LI>
            <B>&ldquo;The update could not be installed&rdquo;.</B>{' '}After a restart Plasma found it was still on the old version. The message offers{' '}
            <UI>Download manually</UI>{' '}and, on a Mac, names the update helper&rsquo;s log file. The Mac update helper writes <C>update-helper.log</C>{' '}in Plasma&rsquo;s logs folder, and it is included in a{' '}
            <Doc to="reliability#support-bundle">support bundle</Doc>.
          </LI>
          <LI>
            <B>Settings says the update feed is behind.</B>{' '}The published feed advertises an older version than you run, so automatic updates cannot reach
            you. Download the current build from the site.
          </LI>
          <LI>
            <B>Did I lose my work when the app restarted?</B>{' '}Open SQL tabs are saved and come back; the restart lists anything that would be lost before it
            happens. See <Doc to="install#update-unsaved">What happens to unsaved work</Doc>.
          </LI>
        </UL>
      ),
    },
    {
      id: 'connecting',
      title: 'Connections',
      body: (
        <UL>
          <LI>
            <B>Read the message.</B> <UI>Test</UI>{' '}stops at the first failing step and explains it. The full list is in{' '}
            <Doc to="connections#test">Test, errors and diagnosis</Doc>.
          </LI>
          <LI>
            <B>&ldquo;Nothing is listening there&rdquo;.</B>{' '}The host answered but refused the port. Check the port number, that the server is running, and that
            it listens on that address.
          </LI>
          <LI>
            <B>&ldquo;The server does not allow this login from here&rdquo;.</B>{' '}The server has no rule for your user from this machine (for PostgreSQL, a{' '}
            <C>pg_hba.conf</C>{' '}rule).
          </LI>
          <LI>
            <B>A certificate error.</B>{' '}Either choose the CA file in <UI>Security</UI>{' '}(<UI>CA certificate</UI>) or fix the host name; <UI>Verify CA and host
            name</UI>{' '}requires the certificate to name the host you typed.
          </LI>
          <LI>
            <B>Through SSH, &ldquo;The jump host could not reach the database&rdquo;.</B>{' '}SSH worked, but the bastion cannot open the database host and port you
            gave. Remember the host in the form is the one as the bastion sees it.
          </LI>
          <LI>
            <B>My saved password is gone or not saved.</B>{' '}Plasma refuses to save secrets when the operating system has no working secret store; see Linux
            above.
          </LI>
          <LI>
            <B>It keeps reconnecting.</B>{' '}Use <UI>Stop reconnecting</UI>{' '}in the connection menu, or turn off <UI>Connection lost: Retry automatically</UI>.
          </LI>
        </UL>
      ),
    },
    {
      id: 'working',
      title: 'Editing and queries',
      body: (
        <UL>
          <LI>
            <B>I can&rsquo;t edit a cell.</B>{' '}Turn on edit mode with the lock button. It stays disabled on a read-only connection, and the grid cannot edit ClickHouse
            or DuckDB results. A table with no primary key cannot delete rows safely.
          </LI>
          <LI>
            <B>My commit said a row changed.</B>{' '}Someone changed it after you loaded it. Your edits are still staged; choose <UI>Keep mine</UI>{' '}or{' '}
            <UI>Take theirs</UI>{' '}per row. See <Doc to="results#conflicts">Conflict detection</Doc>.
          </LI>
          <LI>
            <B>A write was refused.</B>{' '}The connection is read-only, or Safe mode is set to Read-only. Both name themselves in the message.
          </LI>
          <LI>
            <B>My query shows &ldquo;Waiting for the connection&rdquo;.</B>{' '}Another tab is using that connection; statements on one connection run one at a time.
            Cancel the other one, or wait.
          </LI>
          <LI>
            <B>Cancel says it is still cancelling.</B>{' '}The server has not stopped the statement yet. Use <UI>Cancel again</UI>{' '}or <UI>Disconnect to stop it</UI>.
            SQLite cannot interrupt a statement that returns no rows for a long time.
          </LI>
          <LI>
            <B>The result stops at 10,000 rows.</B>{' '}That is the in-memory cap (also about 32 MiB). Use <UI>Export</UI>{' '}with <UI>Whole table</UI>{' '}or{' '}
            <UI>Full result</UI>{' '}to stream everything to a file.
          </LI>
          <LI>
            <B>psql commands (<C>\d</C>) and COPY FROM STDIN fail.</B>{' '}Plasma runs SQL only. Use the sidebar, <UI>Import</UI>{' '}and <UI>Export</UI>.
          </LI>
          <LI>
            <B>Values look blacked out.</B>{' '}Presentation mode is on (<Doc to="results#presentation">masking</Doc>). Turn it off with the top-bar button.
          </LI>
        </UL>
      ),
    },
    {
      id: 'backup',
      title: 'Backup, restore and import',
      body: (
        <UL>
          <LI>
            <B>Backup says it cannot find <C>pg_dump</C>.</B>{' '}Install the PostgreSQL client tools, or set the folder under <UI>Settings</UI>{' '}&rarr;{' '}
            <UI>Advanced</UI>{' '}&rarr; <UI>PostgreSQL tools</UI>. A <UI>Version mismatch</UI>{' '}badge means the tool&rsquo;s major version differs from the server&rsquo;s; a <C>pg_dump</C>{' '}older than the server will refuse to dump.
          </LI>
          <LI>
            <B>Restore needs the database to exist.</B>{' '}Create it first, then choose it as the target.
          </LI>
          <LI>
            <B>An import changed nothing.</B>{' '}It runs in one transaction; any error rolls it all back and the dialog shows the error. A cancelled import also
            imports nothing.
          </LI>
        </UL>
      ),
    },
    {
      id: 'mcp-ai',
      title: 'MCP and AI',
      body: (
        <UL>
          <LI>
            <B>The MCP status says the port is in use.</B>{' '}Pick another port in <UI>Settings</UI>{' '}&rarr; <UI>MCP server</UI>{' '}and update your client&rsquo;s config.
          </LI>
          <LI>
            <B>My client gets 401.</B>{' '}The token is wrong, or you regenerated it. Copy the snippet again.
          </LI>
          <LI>
            <B>A browser-based tool gets 403.</B>{' '}Plasma rejects any request that carries an <C>Origin</C>{' '}header; use a local client.
          </LI>
          <LI>
            <B>A tool says &ldquo;does not allow … for AI tools&rdquo;.</B>{' '}The connection&rsquo;s access level is too low. Change it in the MCP section.
          </LI>
          <LI>
            <B>The stdio bridge says &ldquo;Open Plasma and turn on the MCP server in Settings&rdquo;.</B>{' '}Plasma is not running or the server is off.
          </LI>
          <LI>
            <B>The assistant can&rsquo;t see my tables.</B>{' '}Schema context is off, or the connection is tagged Prod and you have not opted in. The line under the
            message box shows <C>Schema: off</C>. See <Doc to="ai-assistant#what-is-sent">What is sent</Doc>.
          </LI>
          <LI>
            <B>The agent does nothing with a local model.</B>{' '}Choose a model that supports tool calling.
          </LI>
        </UL>
      ),
    },
    {
      id: 'faq',
      title: 'FAQ',
      body: (
        <>
          <P>
            <B>Is Plasma free?</B>{' '}Yes. It is open source under the Apache-2.0 license, and you do not need an account.
          </P>
          <P>
            <B>Which databases?</B>{' '}PostgreSQL, MySQL, MariaDB, SQLite, ClickHouse, DuckDB, Redis and OpenSearch.
          </P>
          <P>
            <B>Do I need AI?</B>{' '}No. It is optional and off until you add a key or a local model.
          </P>
          <P>
            <B>Where are my settings and history?</B>{' '}In a local database in Plasma&rsquo;s user-data folder on your computer. See{' '}
            <Doc to="safety-privacy#leaves-machine">what leaves your machine</Doc>.
          </P>
          <P>
            <B>How do I report a bug?</B> <UI>Help</UI>{' '}&rarr; <UI>Report a Bug</UI>, and attach a support bundle you have reviewed.
          </P>
        </>
      ),
    },
  ],
};
