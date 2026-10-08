import { Callout } from '@/components/docs/callout';
import { CodeBlock } from '@/components/docs/code-block';
import { DocTable } from '@/components/docs/doc-table';
import { A, B, C, Doc, LI, P, UI, UL } from '@/components/docs/prose';
import { Steps } from '@/components/docs/steps';
import type { DocPage } from './types';

export const install: DocPage = {
  slug: 'install',
  title: 'Install and update',
  group: 'Getting started',
  summary:
    'Download Plasma for macOS (Apple Silicon), Windows or Linux, get past the first-launch warnings, and keep it up to date with one click.',
  sections: [
    {
      id: 'platforms',
      title: 'What you can download',
      body: (
        <>
          <P>
            Plasma is a desktop app. The builds on the <A href="/#download">download section</A>{' '}of the home page
            are the ones listed below. There are no builds for Intel Macs, ARM Windows or ARM Linux.
          </P>
          <DocTable
            caption="Published builds"
            head={['System', 'Files', 'Notes']}
            rows={[
              [
                'macOS',
                <>
                  <C>Plasma-&lt;version&gt;-arm64.dmg</C>, <C>Plasma-&lt;version&gt;-arm64.zip</C>
                </>,
                'Apple Silicon only. The build is not signed by Apple yet.',
              ],
              [
                'Windows',
                <>
                  <C>Plasma-Setup-&lt;version&gt;-x64.exe</C>{' '}(installer), <C>Plasma-Portable-&lt;version&gt;-x64.exe</C>
                </>,
                'x64. The build is not signed by Microsoft yet.',
              ],
              [
                'Linux',
                <>
                  <C>Plasma-&lt;version&gt;-x86_64.AppImage</C>, <C>Plasma-&lt;version&gt;-amd64.deb</C>
                </>,
                'x64.',
              ],
            ]}
          />
          <P>
            Plasma is free and open source (Apache-2.0). You do not need an account to use it.
          </P>
        </>
      ),
    },
    {
      id: 'macos',
      title: 'macOS',
      body: (
        <>
          <Steps
            items={[
              {
                title: 'Open the disk image',
                body: (
                  <P>
                    Open the <C>.dmg</C>, then drag Plasma into <B>Applications</B>. Keep it there: an app that runs
                    straight from the disk image or from Downloads cannot replace itself when an update arrives.
                  </P>
                ),
              },
              {
                title: 'Open it the first time',
                body: (
                  <>
                    <P>
                      The build has no Apple signature, so macOS can refuse to open it. Open <UI>System Settings</UI>,
                      then <UI>Privacy &amp; Security</UI>, and click <UI>Open Anyway</UI>{' '}next to the Plasma message.
                    </P>
                    <P>You can also clear the download flag from a terminal:</P>
                    <CodeBlock label="Terminal" code="xattr -cr /Applications/Plasma.app" />
                  </>
                ),
              },
              {
                title: 'Allow the keychain item',
                body: (
                  <P>
                    Plasma keeps a key for your saved passwords in the login keychain, in an item called
                    &ldquo;Plasma Safe Storage&rdquo;. After an update macOS may ask, once, whether Plasma can use that
                    item again. Click <UI>Always Allow</UI>. This happens because the build has no certificate-backed
                    signature, so the keychain sees each build as a different app.
                  </P>
                ),
              },
            ]}
          />
        </>
      ),
    },
    {
      id: 'windows',
      title: 'Windows',
      body: (
        <>
          <UL>
            <LI>
              <B>Installer</B>{' '}(<C>Plasma-Setup-&lt;version&gt;-x64.exe</C>). It is not a one-click installer: it asks
              whether to install for you only or for all users, and lets you choose the install folder. It creates a
              desktop shortcut and a Start menu entry named Plasma.
            </LI>
            <LI>
              <B>Portable</B>{' '}(<C>Plasma-Portable-&lt;version&gt;-x64.exe</C>). Runs without installing. A portable
              copy cannot update itself; download the new file instead.
            </LI>
          </UL>
          <P>
            Windows may show a SmartScreen warning because the build has no Microsoft signature yet. Click{' '}
            <UI>More info</UI>, then <UI>Run anyway</UI>.
          </P>
          <Callout kind="note" title="All-users installs">
            If you install into Program Files for all users, an update needs administrator rights. Plasma then shows a
            download button instead of updating itself. The default per-user install updates by itself.
          </Callout>
        </>
      ),
    },
    {
      id: 'linux',
      title: 'Linux',
      body: (
        <>
          <P>Pick one of two packages.</P>
          <UL>
            <LI>
              <B>AppImage.</B>{' '}Make it executable and run it:
            </LI>
          </UL>
          <CodeBlock label="Terminal" code={'chmod +x Plasma-<version>-x86_64.AppImage\n./Plasma-<version>-x86_64.AppImage'} />
          <UL>
            <LI>
              <B>.deb.</B>{' '}Install it with your package manager, for example:
            </LI>
          </UL>
          <CodeBlock label="Terminal" code="sudo apt install ./Plasma-<version>-amd64.deb" />
          <P>
            The AppImage updates itself. A <C>.deb</C>{' '}install needs administrator rights to update, so Plasma shows a
            download button for the new package instead.
          </P>
          <Callout kind="note" title="The Chromium sandbox on newer Ubuntu">
            Some systems (Ubuntu 24.04 and later among them) restrict the user namespaces that the Chromium sandbox
            needs. The <C>.deb</C>{' '}installs an AppArmor profile so the sandbox keeps working. An AppImage cannot do
            that: when the kernel blocks the sandbox, the AppImage prints a message and starts Plasma without it. Install
            the <C>.deb</C>{' '}if you want the sandbox.
          </Callout>
          <Callout kind="note" title="A keyring is needed to save passwords">
            Saved database passwords, SSH keys and API keys are encrypted with the operating system&rsquo;s secret
            store. On Linux that means GNOME Keyring or KWallet. Without one, Plasma asks you at startup: do not store
            secrets, or store them with weak protection. See{' '}
            <Doc to="safety-privacy#secrets">Where secrets are stored</Doc>.
          </Callout>
        </>
      ),
    },
    {
      id: 'updates',
      title: 'Updates',
      body: (
        <>
          <P>
            Plasma checks its release feed for a new version and downloads it in the background. When the download is
            ready, a <UI>Restart to update</UI>{' '}button appears in the top bar and a notice says{' '}
            <UI>Plasma &lt;version&gt; is ready</UI>, with a <UI>What&rsquo;s new</UI>{' '}link to the release notes. One
            click installs it and reopens Plasma. You can also look for updates yourself in{' '}
            <UI>Settings</UI>{' '}&rarr; <UI>Advanced</UI>{' '}&rarr; <UI>Check now</UI>; the same section shows the version you
            run and when the feed was last checked.
          </P>
        </>
      ),
      subs: [
        {
          id: 'update-unsaved',
          title: 'What happens to unsaved work',
          body: (
            <>
              <P>
                If nothing is at stake, the restart happens straight away. Otherwise Plasma lists what the restart would
                lose and asks you to confirm. It can name any of these:
              </P>
              <UL>
                <LI>an open transaction (it will be rolled back);</LI>
                <LI>unsaved grid edits;</LI>
                <LI>a Safe Run waiting for Commit or Roll back (it will be rolled back);</LI>
                <LI>a query that is still running (it will be cancelled);</LI>
                <LI>SQL tabs with unsaved text that cannot be restored.</LI>
              </UL>
              <P>
                Your open SQL tabs are written to disk before the restart and come back afterwards, so ordinary unsaved
                SQL text is not on that list. The confirmation button reads <UI>Restart and discard</UI>.
              </P>
            </>
          ),
        },
        {
          id: 'update-by-platform',
          title: 'Which installs update themselves',
          body: (
            <>
              <DocTable
                head={['Install', 'Update']}
                rows={[
                  ['Windows installer (per user)', 'Automatic: downloads, then installs without installer windows when you restart.'],
                  ['Windows portable, or installed for all users', 'Manual: Plasma offers the download page.'],
                  ['Linux AppImage', 'Automatic. Plasma keeps a backup link of the old file during the swap and restores it if the swap fails.'],
                  ['Linux .deb', 'Manual: install the new package.'],
                  [
                    'macOS (in Applications)',
                    <>
                      Automatic: Plasma installs the new app itself and reopens. If it runs from a disk image or another
                      place it cannot write to, the top bar shows an <UI>Update</UI>{' '}button for a manual download and
                      Settings says &ldquo;Move Plasma to Applications to get automatic updates.&rdquo;
                    </>,
                  ],
                ]}
              />
              <P>
                On every platform a failed or refused update shows a message in the top bar; click it to try again. An
                update the app cannot verify is never installed: the message then reads{' '}
                <C>Update refused: &lt;reason&gt;</C>.
              </P>
            </>
          ),
        },
        {
          id: 'update-trust',
          title: 'How updates are checked',
          body: (
            <>
              <P>
                The builds are not code-signed by Apple or Microsoft, so Plasma protects the update channel itself. The
                release manifest carries an ed25519 signature that Plasma checks against a public key built into the
                app. The version and the checksum of every file must match the signed manifest before the download
                counts, and the downloaded file is hashed again on disk before it is installed. Downgrades and
                prereleases are refused.
              </P>
            </>
          ),
        },
      ],
    },
  ],
};
