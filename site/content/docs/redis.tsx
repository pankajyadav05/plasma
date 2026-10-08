import { Callout } from '@/components/docs/callout';
import { DocTable } from '@/components/docs/doc-table';
import { Shot } from '@/components/docs/figure';
import { Keys } from '@/components/docs/keys';
import { B, C, Doc, LI, P, UI, UL } from '@/components/docs/prose';
import type { DocPage } from './types';

export const redis: DocPage = {
  slug: 'redis',
  title: 'Redis',
  group: 'Engine guides',
  summary:
    'Browse keys by namespace, read and edit typed values, set TTLs, run commands in a guarded CLI, analyse memory, read the slow log and watch pub/sub and keyspace events.',
  sections: [
    {
      id: 'connect',
      title: 'Connecting',
      body: (
        <P>
          Choose <UI>Redis</UI>, or paste a <C>redis://</C>{' '}or <C>rediss://</C>{' '}(TLS) URL. Default port 6379; <UI>ACL user
          (optional)</UI>{' '}and <UI>Password</UI>{' '}for authentication; <UI>DB index</UI>{' '}for the database to open first. The host can
          also be a unix socket, <C>sentinel://…</C>{' '}or <C>cluster://…</C>; see{' '}
          <Doc to="connections#redis-hosts">Redis hosts</Doc>. Redis has no SQL editor, history or Safe Run; its workbench is the
          set of views below.
        </P>
      ),
    },
    {
      id: 'browser',
      title: 'The key browser',
      body: (
        <>
          <Shot k="redis" caption="The key tree and a hash open in its typed editor." />
          <P>
            The sidebar lists keys as a tree, split on <C>:</C>, so <C>user:42:profile</C>{' '}sits under <C>user</C>{' '}and <C>42</C>. A
            row shows the key type and, when it has one, a TTL badge. Keys are found with <C>SCAN</C>, never <C>KEYS</C>, so a big
            database does not stall the server; <UI>Load more keys</UI>{' '}(or <UI>Keep searching</UI>{' '}while a pattern or type filter is set) continues the scan. The count shown is the key count of the
            database you are browsing.
          </P>
          <UL>
            <LI>
              <B>Filter.</B>{' '}The search box takes a <C>MATCH</C>{' '}pattern such as <C>user:*</C>. The type filter limits the scan to
              All types, Strings, Hashes, Lists, Sets, Sorted sets, Streams or JSON.
            </LI>
            <LI>
              <B>Databases.</B>{' '}Click a database chip (<C>db0</C>, <C>db1</C>{' '}…) to <C>SELECT</C>{' '}it; the chips show how many keys each
              holds.
            </LI>
            <LI>
              <B>Prefix actions</B>{' '}(the menu on a folder): <UI>Copy pattern</UI>, <UI>Scan only this prefix</UI>,{' '}
              <UI>New key here…</UI>, <UI>Delete all under prefix…</UI>.
            </LI>
            <LI>
              <B>Tools menu:</B> <UI>redis-cli</UI>, <UI>Server info</UI>, <UI>Memory analyzer</UI>, <UI>Slowlog</UI>,{' '}
              <UI>Pub/sub subscribe…</UI>, <UI>Keyspace events tail</UI>, <UI>New key…</UI>, <UI>Delete keys matching…</UI>,{' '}
              <UI>Bulk select</UI>{' '}and <UI>Rescan keyspace</UI>.
            </LI>
          </UL>
          <P>
            The <UI>Overview</UI>{' '}tab shows version, mode, role, memory used, clients, uptime, the number of databases, key
            counts and how many keys carry a TTL, plus a per-database keyspace table, with auto-refresh of off, 5 s or 30 s.
          </P>
        </>
      ),
    },
    {
      id: 'values',
      title: 'Reading and editing values',
      body: (
        <>
          <P>
            A key opens in an editor that matches its type: string, hash, list, set, sorted set, stream or a RedisJSON document.
            Values that are not valid UTF-8 are shown safely, and a view switch offers <UI>Auto</UI>{' '}(pretty-prints JSON),{' '}
            <UI>Raw</UI>{' '}(<UI>Escaped</UI>{' '}for binary) and <UI>Hex</UI>. Collections load in pages with a pattern filter, and
            sorted sets and streams can be ordered either way. A string longer than 1 MiB is not fetched in full: you see a
            preview of the first 64 KiB marked <UI>Large value &mdash; not fetched</UI>, and it cannot be edited as text.
          </P>
          <P>
            Streams also show their consumer groups (consumers, pending entries, last delivered ID and lag).
          </P>
          <UL>
            <LI>
              <B>Edit</B>{' '}needs edit mode and a connection that is not read-only: <UI>Edit string</UI>,{' '}
              <UI>Edit JSON document</UI>, <UI>Set field</UI>{' '}(<C>HSET</C>), <UI>Add member</UI>{' '}(<C>SADD</C>, <C>ZADD</C>,
              list pushes), per-row edit and remove buttons. Removing an element asks first. Binary or truncated values cannot be
              edited as text.
            </LI>
            <LI>
              <B>TTL.</B> <UI>Edit TTL</UI>{' '}sets seconds (<C>EXPIRE</C>), milliseconds (<C>PEXPIRE</C>) or a point in time (
              <C>EXPIREAT</C>), and removes the expiry with <C>PERSIST</C>. The displayed TTL counts down live.
            </LI>
            <LI>
              <B>Key actions:</B> <UI>Copy key name</UI>, <UI>Copy value</UI>, <UI>Open redis-cli</UI>, <UI>Rename…</UI>,{' '}
              <UI>Duplicate…</UI>, and <UI>Delete key</UI>, which uses <C>UNLINK</C>{' '}and asks first.
            </LI>
            <LI>
              <B>New key…</B>{' '}creates a String, Hash, List, Set, Sorted set, Stream or JSON key, with an optional expiry in seconds.
            </LI>
          </UL>
        </>
      ),
    },
    {
      id: 'safety',
      title: 'Write safety',
      body: (
        <>
          <P>
            Redis has no read-only switch, so Plasma applies one itself. Writes are available only when edit mode is on and the
            connection is not marked read-only; the app&rsquo;s main process refuses write requests on a read-only connection
            even if a button were to slip through. On a connection tagged Prod, every write from the CLI asks first.
          </P>
          <UL>
            <LI>
              <B>Bulk delete.</B> <UI>Delete keys matching…</UI>{' '}and <UI>Delete all under prefix…</UI>{' '}run{' '}
              <C>SCAN MATCH</C>{' '}to preview first (&ldquo;nothing is deleted until you confirm&rdquo;), then <C>UNLINK</C>{' '}in batches. On a
              Prod connection you must type the number of matched keys to confirm. Selecting keys with <UI>Bulk select</UI>{' '}and
              clicking <UI>Delete selected</UI>{' '}asks too, and reports any key that could not be deleted.
            </LI>
          </UL>
        </>
      ),
    },
    {
      id: 'cli',
      title: 'redis-cli',
      body: (
        <>
          <P>
            The <UI>redis-cli</UI>{' '}view takes a command (<C>GET myKey</C>) and runs it on the connection. Use the up and down
            arrows for earlier commands (the last 500 are kept). Quoting follows redis-cli: double quotes with backslash escapes,
            single quotes, and <C>&quot;&quot;</C>{' '}for an empty argument. The classifier is conservative &mdash; anything not known to be
            a read is treated as a write.
          </P>
          <DocTable
            head={['Command kind', 'What Plasma does']}
            rows={[
              ['Reads', 'Runs.'],
              ['Writes', 'Runs only with edit mode on and a writable connection; asks first on Prod.'],
              ['Destructive or expensive (for example FLUSHALL, KEYS on a big database)', 'Always asks, with the reason.'],
              ['Blocking (BLPOP and friends)', 'Runs on a short-lived dedicated connection with a deadline; the Cancel button unblocks it.'],
              ['SUBSCRIBE, PSUBSCRIBE, MONITOR, and CLIENT commands that change connection state', 'Refused, because they would take over the connection every view shares. The message points to the Pub/sub view or the Slowlog.'],
              ['SELECT n', 'Switches database, like the chips in the sidebar.'],
            ]}
          />
          <P>
            Note that <C>DEL</C>{' '}and <C>UNLINK</C>{' '}do not expand patterns; a command that contains a glob is flagged for that
            reason.
          </P>
        </>
      ),
    },
    {
      id: 'analysis',
      title: 'Memory analyzer, slow log and server',
      body: (
        <>
          <UL>
            <LI>
              <B>Memory analyzer.</B>{' '}Samples keys with <C>SCAN</C>{' '}(optionally with a <C>MATCH</C>{' '}pattern; the sample cap is 1
              to 50,000) and measures each with <C>MEMORY USAGE</C>. It reports keys scanned, total bytes, the biggest key, and
              breakdowns by type and by prefix. It can be stopped with <UI>Cancel analyze</UI>.
            </LI>
            <LI>
              <B>Slowlog.</B>{' '}The server&rsquo;s slow log with id, time, duration in microseconds, client and command. A reset
              button asks first (<C>SLOWLOG RESET</C>{' '}discards every entry).
            </LI>
            <LI>
              <B>Server.</B>{' '}Three tabs: <UI>Info</UI>{' '}(<C>INFO</C>{' '}by section), <UI>Clients</UI>{' '}(with a <C>CLIENT KILL</C>{' '}button
              that asks first) and <UI>Config</UI>{' '}(<C>CONFIG GET</C>, with an edit button that runs <C>CONFIG SET</C>{' '}after a
              confirmation: it changes the live configuration, not <C>redis.conf</C>).
            </LI>
          </UL>
        </>
      ),
    },
    {
      id: 'pubsub',
      title: 'Pub/sub and keyspace events',
      body: (
        <>
          <P>
            <UI>Pub/sub subscribe…</UI>{' '}asks for a channel and subscribes with <C>SUBSCRIBE</C>, or with <C>PSUBSCRIBE</C>{' '}for a
            pattern. Messages stream in newest first, capped at 2,000 (a message longer than 64 KiB is cut). <UI>Filter
            messages</UI>{' '}accepts text, <C>channel:</C>{' '}or <C>payload:</C>{' '}prefixes and <C>!</C>{' '}to exclude; <UI>Pause</UI>{' '}and{' '}
            <UI>Clear messages</UI>{' '}control the view. A subscription uses its own connection, so it never affects the other views.
          </P>
          <P>
            <UI>Keyspace events tail</UI>{' '}(also in the palette as <UI>Tail keyspace events</UI>) subscribes to the database&rsquo;s
            keyevent channels to show which keys are being written, expired or deleted. It needs the server&rsquo;s{' '}
            <C>notify-keyspace-events</C>{' '}setting; if it is off, a banner offers <UI>Enable</UI>, which asks before it runs{' '}
            <C>CONFIG SET notify-keyspace-events …</C>. That changes the live configuration for every client until the server
            restarts and costs some CPU on busy servers. It is disabled on a read-only connection.
          </P>
        </>
      ),
    },
    {
      id: 'health',
      title: 'Health advisor',
      body: (
        <P>
          <UI>Health</UI>{' '}in the icon rail shows read-only checks: <UI>Memory</UI>, <UI>Latency</UI>{' '}(with a note when the latency
          monitor is off), <UI>Slow log</UI>{' '}summary, <UI>Clients</UI>{' '}(with <C>CLIENT KILL</C>), and sampled <UI>Big keys</UI>{' '}and{' '}
          <UI>Hot keys</UI>{' '}(hot keys need an LFU eviction policy, and the view says so). Sampling uses <C>SCAN</C>{' '}with a{' '}
          <C>MATCH</C>{' '}pattern and a sample cap you set, can be stopped, and draws a treemap of the <UI>Top prefixes</UI>{' '}by memory
          in which you can click a prefix to select it.
        </P>
      ),
    },
    {
      id: 'ai',
      title: 'AI on Redis',
      body: (
        <P>
          The assistant understands Redis too. It can propose commands, and when you allow row data for the connection it can run a
          read-only allow-list of commands (such as <C>GET</C>, <C>HGETALL</C>, <C>LRANGE</C>, <C>SCAN</C>) to look at values. See{' '}
          <Doc to="ai-assistant">AI assistant</Doc>{' '}for what is sent.
        </P>
      ),
    },
  ],
};
