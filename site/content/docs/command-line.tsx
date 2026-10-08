import { Callout } from '@/components/docs/callout';
import { CodeBlock } from '@/components/docs/code-block';
import { DocTable } from '@/components/docs/doc-table';
import { B, C, Doc, LI, P, UI, UL } from '@/components/docs/prose';
import { Steps } from '@/components/docs/steps';
import type { DocPage } from './types';

export const commandLine: DocPage = {
  slug: 'command-line',
  title: 'Command line and links',
  group: 'Getting started',
  summary:
    'The plasma command opens connections, files and folders in the running app, imports a file into a table, and bridges AI tools. plasma:// links do the same from a web page or a README.',
  sections: [
    {
      id: 'install-cli',
      title: 'Install the plasma command',
      body: (
        <>
          <P>
            Open <UI>Settings</UI>{' '}&rarr; <UI>Advanced</UI>{' '}and find the <UI>Command line</UI>{' '}row.
          </P>
          <UL>
            <LI>
              <B>macOS and Linux.</B>{' '}Click <UI>Install command-line tool</UI>. Plasma asks where to put it:{' '}
              <UI>Install for me</UI>{' '}links <C>plasma</C>{' '}into <C>~/.local/bin</C>, which needs no administrator
              rights; <UI>Install system-wide</UI>{' '}uses <C>/usr/local/bin</C>{' '}and may need <C>sudo</C>. If that folder
              is not on your <C>PATH</C>, the row says so. Plasma never overwrites an unrelated file named{' '}
              <C>plasma</C>. For an AppImage it writes a small wrapper that points at the AppImage file, and fixes the
              wrapper after an AppImage update.
            </LI>
            <LI>
              <B>Windows.</B>{' '}The row shows instructions instead: add the folder that holds the launcher to your{' '}
              <C>PATH</C>{' '}(with <C>setx PATH</C>) and open a new terminal.
            </LI>
          </UL>
          <P>
            If the launcher cannot find the app it prints <C>cannot find the Plasma app</C>. Set the{' '}
            <C>PLASMA_APP</C>{' '}environment variable to the app&rsquo;s executable and try again.
          </P>
        </>
      ),
    },
    {
      id: 'commands',
      title: 'Commands',
      body: (
        <>
          <DocTable
            head={['Command', 'What it does']}
            rows={[
              [
                <C key="o">plasma open &lt;target&gt;</C>,
                'Hands the target to the running Plasma, or starts it. The terminal comes back immediately.',
              ],
              [
                <C key="i">plasma import &lt;file&gt; --into &lt;url&gt; --table &lt;name&gt;</C>,
                'Opens the import dialog for a file and a table.',
              ],
              [
                <C key="m">plasma mcp</C>,
                'A stdio bridge to the running Plasma for AI clients that cannot make HTTP requests. See the MCP server page.',
              ],
              [<C key="h">plasma --help</C>, 'Prints usage.'],
            ]}
          />
        </>
      ),
      subs: [
        {
          id: 'open',
          title: 'plasma open',
          body: (
            <>
              <P>
                The target can be one of three things, or a <Doc to="command-line#deep-links">plasma:// link</Doc>,
                which is handled exactly like a clicked link.
              </P>
              <UL>
                <LI>
                  <B>A connection URL</B>{' '}(anything with <C>://</C>, such as <C>postgres://user@host:5432/db</C>). The
                  New connection dialog opens filled in. Plasma does not connect for you and does not save anything.
                </LI>
                <LI>
                  <B>A SQLite file.</B>{' '}The New connection dialog opens with the engine set to SQLite and the file
                  chosen. A file that is not a SQLite database is reported with the reason.
                </LI>
                <LI>
                  <B>A folder.</B>{' '}Opens it as a <Doc to="connections#workspaces">team workspace</Doc>{' '}(the folder
                  should hold a <C>.plasma/</C>{' '}directory).
                </LI>
              </UL>
              <CodeBlock
                label="Terminal"
                code={'plasma open postgres://app@localhost:5432/shop?sslmode=verify-full\nplasma open ./data/app.sqlite\nplasma open ~/work/our-repo'}
              />
              <P>
                A password inside a URL goes into the dialog&rsquo;s password field only. Plasma masks it before writing
                the link to its log.
              </P>
            </>
          ),
        },
        {
          id: 'import',
          title: 'plasma import',
          body: (
            <>
              <P>
                <C>--into</C>{' '}is a connection URL and <C>--table</C>{' '}is <C>table</C>{' '}or <C>schema.table</C>. The file
                must exist. Plasma opens the <UI>Import</UI>{' '}dialog for that file and table; you still review the
                preview and the column mapping and click through, exactly as if you had started from the app. See{' '}
                <Doc to="schema-tools#import">Import data</Doc>.
              </P>
              <CodeBlock
                label="Terminal"
                code="plasma import ./new_customers.csv --into postgres://app@localhost/shop --table public.customers"
              />
            </>
          ),
        },
      ],
    },
    {
      id: 'deep-links',
      title: 'plasma:// links',
      body: (
        <>
          <P>Plasma registers the <C>plasma://</C>{' '}scheme. Two links exist.</P>
          <DocTable
            head={['Link', 'Effect']}
            rows={[
              [
                <C key="c">plasma://connect?url=&lt;connection-url&gt;&amp;name=&lt;label&gt;&amp;readonly=1</C>,
                <>
                  Opens the New connection dialog filled in. <C>name</C>{' '}is optional (up to 80 characters).{' '}
                  <C>readonly</C>{' '}accepts <C>1</C>, <C>true</C>, <C>yes</C>{' '}or <C>on</C>{' '}and ticks the Read-only switch.
                </>,
              ],
              [
                <C key="w">plasma://open?workspace=&lt;absolute folder&gt;</C>,
                'Asks you to confirm, then opens the folder as a workspace. The path must be absolute.',
              ],
            ]}
          />
          <Callout kind="warning" title="Links are untrusted input">
            Any web page can fire a <C>plasma://</C>{' '}link, so a link can only fill in a dialog. It never connects and
            never runs anything. A workspace link asks for your confirmation first. Links longer than 4096 characters
            or with an unknown action are rejected with a message. Commands you type in a terminal are your own and
            skip the confirmation.
          </Callout>
        </>
      ),
    },
  ],
};
