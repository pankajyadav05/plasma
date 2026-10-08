import { Callout } from '@/components/docs/callout';
import { DocTable } from '@/components/docs/doc-table';
import { B, C, Doc, LI, P, UI, UL } from '@/components/docs/prose';
import { Steps } from '@/components/docs/steps';
import type { DocPage } from './types';

export const reliability: DocPage = {
  slug: 'reliability',
  title: 'Reliability and support',
  group: 'Safety and reliability',
  summary:
    'What happens when Plasma crashes or the network drops, how it reconnects without repeating a write, and how to make a support bundle you can read before you send it.',
  sections: [
    {
      id: 'crash-recovery',
      title: 'Crash recovery',
      body: (
        <>
          <P>
            While you work, Plasma writes a small snapshot of your session to disk: your open tabs and their SQL, the grid edits you have
            staged (with the original values they were staged against), and whether a transaction was open. It is saved atomically, so a crash
            in mid-write leaves the previous complete snapshot. After a crash, a force-quit or a power cut, the next launch brings the session
            back.
          </P>
          <UL>
            <LI>
              A notice names what happened: <UI>Plasma closed unexpectedly</UI>, or <UI>The Plasma window crashed and was reloaded</UI>, and
              what came back (&ldquo;Restored 4 tabs and 3 unsaved edits.&rdquo;). It can offer <UI>Discard edits</UI>{' '}and <UI>Show crash log</UI>.
            </LI>
            <LI>
              <B>Nothing is replayed.</B>{' '}Restoring re-opens tabs and re-stages edits; it never runs a statement. Staged edits are not committed
              until you commit them.
            </LI>
            <LI>
              A transaction that was open is gone, and the notice says so: &ldquo;Your open transaction was rolled back, so its changes are gone.&rdquo;
            </LI>
            <LI>
              If a commit was in flight when Plasma stopped, those edits come back flagged as possibly already saved, with a reminder to check the data
              before committing. If something could not be saved (an edit, or a SQL tab too large), the notice counts it as lost.
            </LI>
            <LI>
              Snapshots belong to a connection. If the saved connection now points at another host or database, the edits are not applied there;
              the notice <UI>Saved work belongs to a different database</UI>{' '}lets you <UI>Open its SQL</UI>{' '}or <UI>Discard</UI>{' '}it. A snapshot whose
              connection no longer exists is offered as <UI>Unsaved work from an earlier session</UI>{' '}with <UI>Discard</UI>{' '}or <UI>Keep for later</UI>.
            </LI>
          </UL>
          <P>
            Separately, closing the window with unsaved work asks first, and starting a second copy of Plasma on the same profile just brings the
            first one forward.
          </P>
        </>
      ),
    },
    {
      id: 'reconnect',
      title: 'Connection loss and reconnecting',
      body: (
        <>
          <P>
            A laptop that sleeps, a Wi-Fi change or a VPN reconnect can leave Plasma holding sockets whose other end is gone. Plasma detects that a
            failure was a lost connection (as opposed to a SQL error, which never triggers a reconnect) and handles it in two layers.
          </P>
          <Steps
            items={[
              {
                title: 'A silent retry',
                body: (
                  <P>
                    The first time a request comes back as a lost connection, Plasma rebuilds the session (including the SSH tunnel) and retries the request
                    once. This is done for reads only. A write is never replayed: it reports that the connection dropped, and what you see is described
                    below.
                  </P>
                ),
              },
              {
                title: 'Automatic reconnect',
                body: (
                  <P>
                    If that fails, the connection capsule reads <UI>Reconnecting to &lt;name&gt;… (attempt N)</UI>. Plasma tries again after 2, 5, 10, 30
                    and 60 seconds, and again as soon as the network comes back. When it gives up the capsule reads{' '}
                    <UI>Couldn&rsquo;t reach &lt;name&gt; &mdash; click to reconnect</UI>, with the plain-language reason. Clicking the capsule reconnects
                    at any time. <UI>Stop reconnecting</UI>{' '}in the connection menu ends the attempts.
                  </P>
                ),
              },
            ]}
          />
          <UL>
            <LI>
              <UI>Settings</UI>{' '}&rarr; <UI>General</UI>{' '}has <UI>Connection lost: Retry automatically</UI>{' '}(on by default) and{' '}
              <UI>On launch: Reconnect to the last connection</UI>. A deliberate disconnect is remembered, so Plasma does not reconnect after it on the
              next launch. If the database is unreachable at launch, the same retry schedule applies.
            </LI>
            <LI>
              A tab whose statement was cut off by the drop says <UI>Connection dropped</UI>{' '}(a read; run it again) or <UI>Outcome unknown</UI>{' '}(a write,
              which Plasma does not repeat).
            </LI>
          </UL>
        </>
      ),
    },
    {
      id: 'support-bundle',
      title: 'Support bundle',
      body: (
        <>
          <P>
            When something goes wrong, a support bundle gives whoever is helping you the facts without your data. Create it from{' '}
            <UI>Help</UI>{' '}&rarr; <UI>Create Support Bundle…</UI>, the command palette (<UI>Create support bundle…</UI>), or{' '}
            <UI>Settings</UI>{' '}&rarr; <UI>Advanced</UI>{' '}&rarr; <UI>Create support bundle…</UI>.
          </P>
          <P>
            The dialog lists every file with its size and a one-line description, and shows each file&rsquo;s exact text. <B>You review all of it before
            anything is saved</B>, then choose where to save a <C>.zip</C>. Nothing is uploaded; you decide who gets the file.
          </P>
          <DocTable
            head={['File', 'What it holds']}
            rows={[
              ['README.txt', 'What the bundle is and is not.'],
              ['system.json', 'App version, operating system and versions of Electron, Chrome and Node, and the engine and server version of the active connection.'],
              ['settings.json', 'Your preferences, without secrets and without anything you wrote.'],
              ['connections.json', 'Saved connections: no passwords, keys or tokens.'],
              ['logs/main.log', 'The last 2,000 lines of the app log.'],
              ['logs/main.old.log', 'The app log before the last rotation (when there is one).'],
              ['logs/worker.log', 'What the database worker printed since Plasma started.'],
              ['logs/update-helper.log', 'The last 200 lines of the update helper log (when there is one).'],
              ['errors.txt', 'The most recent error lines from the logs.'],
            ]}
          />
          <UL>
            <LI>
              It never holds query results, SQL you wrote or ran (history, snippets, saved queries, tabs, start-up SQL, SQL that an error quotes), row
              data, passwords, keys, tokens or connection-string secrets.
            </LI>
            <LI>
              <UI>Also hide host names and user names</UI>{' '}replaces them (and IP addresses and e-mail addresses) with placeholders such as{' '}
              <C>host-1</C>{' '}and <C>user-1</C>, and the preview updates so you can see the result.
            </LI>
          </UL>
        </>
      ),
    },
    {
      id: 'logs',
      title: 'Logs',
      body: (
        <>
          <P>
            The app log is <C>logs/main.log</C>{' '}inside Plasma&rsquo;s user-data folder, capped at 5 MB per file. Renderer messages in a shipped build
            are not written to it, because they can carry query text. SQL and error text that does reach the log is redacted the same way as the query
            history. The user-data folder is normally <C>~/Library/Application Support/Plasma</C>{' '}on macOS, <C>%APPDATA%\Plasma</C>{' '}on Windows and{' '}
            <C>~/.config/Plasma</C>{' '}on Linux; if you set the <C>PLASMA_USER_DATA</C>{' '}environment variable, that folder is used instead, which is also how
            you run a second profile alongside the first.
          </P>
          <Callout kind="note" title="Reporting a bug">
            <UI>Help</UI>{' '}&rarr; <UI>Report a Bug</UI>{' '}opens the issue tracker on GitHub, and <UI>Plasma on GitHub</UI>{' '}opens the repository. Attach a
            support bundle you have read through.
          </Callout>
        </>
      ),
    },
    {
      id: 'workers',
      title: 'Isolation',
      body: (
        <P>
          Database drivers run in a separate worker process, not in the window. A driver that hangs or crashes does not freeze the interface; a long
          query can be cancelled because the worker listens for it, and the app restarts the worker if it exits unexpectedly, and pending requests are failed rather than left hanging.
        </P>
      ),
    },
  ],
};
