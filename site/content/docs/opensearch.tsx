import { Callout } from '@/components/docs/callout';
import { DocTable } from '@/components/docs/doc-table';
import { Shot } from '@/components/docs/figure';
import { Keys } from '@/components/docs/keys';
import { B, C, Doc, LI, P, UI, UL } from '@/components/docs/prose';
import type { DocPage } from './types';

export const opensearch: DocPage = {
  slug: 'opensearch',
  title: 'OpenSearch',
  group: 'Engine guides',
  summary:
    'Browse indices and cluster state, search documents with a query string or the query DSL, run SQL through the SQL plugin, use a Dev Tools-style console, and manage mappings, aliases, templates and lifecycle policies.',
  sections: [
    {
      id: 'connect',
      title: 'Connecting',
      body: (
        <P>
          Choose <UI>OpenSearch</UI>{' '}or paste an <C>https://</C>, <C>http://</C>{' '}or <C>opensearch://</C>{' '}URL; the default port is
          9200. Authenticate with a username and password, an API key or AWS SigV4 (Amazon OpenSearch Service, domain or
          serverless), and add a path prefix and extra nodes if needed; see{' '}
          <Doc to="connections#opensearch-fields">OpenSearch fields</Doc>. When you connect, Plasma checks that the server answers
          like OpenSearch and reports its version; a server that does not is refused. SSH tunnels are not offered for OpenSearch.
        </P>
      ),
    },
    {
      id: 'sidebar',
      title: 'Indices and the overview',
      body: (
        <>
          <Shot k="opensearch" caption="A products index searched with a query string; one document selected in Details." />
          <P>
            The sidebar lists indices with a health dot and, on hover, status, document count and size. Filter with{' '}
            <UI>Search for index…</UI>. The options menu has <UI>Open SQL canvas</UI>, <UI>Open console</UI>, <UI>New index…</UI>,{' '}
            <UI>Refresh</UI>, <UI>Show system indices</UI>{' '}and <UI>Group rolling indices</UI>{' '}(date-suffixed indices such as{' '}
            <C>logs-2026.10.01</C>, rollover-numbered ones and data-stream backing indices fold into one entry when at least three
            share a prefix). Each row opens a search on that index.
          </P>
          <P>
            The cluster <UI>Overview</UI>{' '}tab shows the cluster name, distribution and version, health, node, index and document
            counts, store size and shards, with tabs for <UI>Overview</UI>{' '}(indices, aliases and lifecycle policies),{' '}
            <UI>Nodes</UI>, <UI>Shards</UI>, <UI>Tasks</UI>, <UI>Snapshots</UI>{' '}and <UI>Templates</UI>. It can auto-refresh every few
            seconds (off by default).
          </P>
        </>
      ),
    },
    {
      id: 'search',
      title: 'Searching documents',
      body: (
        <>
          <UL>
            <LI>
              <B>Query.</B>{' '}Type a <C>query_string</C>{' '}expression such as <C>status:200 AND user.id:*</C>{' '}and press Enter (or{' '}
              <Keys k="mod+Enter" />). If the index has a date field, a time-range menu limits results to the last 15 minutes, hour,
              24 hours, 7 days, 30 days or year.
            </LI>
            <LI>
              <B>DSL.</B>{' '}Switch from <UI>Query</UI>{' '}to <UI>DSL</UI>{' '}to write the request body yourself. A <C>size</C>{' '}in the body
              wins over the page-size menu.
            </LI>
            <LI>
              <B>Fields.</B> <UI>Show field list</UI>{' '}opens a tree of the index mapping with <UI>Filter fields…</UI>, and lets you choose
              which columns the table shows (show all, hide all, reset).
            </LI>
            <LI>
              <B>Results.</B>{' '}View them as <UI>Data</UI>{' '}(a table; click a column to sort), <UI>JSON</UI>{' '}or, when the request has
              them, <UI>Aggregations</UI>. Page forwards and back, and set the documents per page.
            </LI>
          </UL>
          <P>
            The <UI>Document actions</UI>{' '}menu has <UI>View document…</UI>{' '}(<UI>Edit document…</UI>{' '}in edit mode),{' '}
            <UI>New document…</UI>, <UI>Delete document</UI>, <UI>Delete matching documents…</UI>{' '}(a <C>_delete_by_query</C>, with
            the match count in the confirmation), <UI>Copy page as JSON</UI>{' '}and <UI>Copy page as CSV</UI>.
          </P>
        </>
      ),
    },
    {
      id: 'console',
      title: 'Console and SQL',
      body: (
        <>
          <P>
            The <UI>Console</UI>{' '}sends any request: pick a method (GET, HEAD, POST, PUT, DELETE or PATCH), type a path such as{' '}
            <C>/_cat/indices?v</C>{' '}and a JSON body, and press <Keys k="mod+Enter" />. Example buttons fill in common reads (cluster
            health, indices, nodes, shards, cluster settings, tasks). A request that can change the cluster asks for confirmation
            (&ldquo;This request can change the cluster.&rdquo;), and a long request can be cancelled.
          </P>
          <P>
            The <UI>SQL</UI>{' '}canvas sends a <C>SELECT</C>{' '}to the SQL plugin (<C>/_plugins/_sql</C>) and shows rows; the plan button
            shows the query plan from <C>_plugins/_sql/_explain</C>. A statement that is not a read asks first.
          </P>
        </>
      ),
    },
    {
      id: 'write-safety',
      title: 'Write safety',
      body: (
        <>
          <P>
            Plasma classifies every request. Anything it cannot prove is a read counts as a write: for example <C>POST</C>{' '}to{' '}
            <C>_search</C>, <C>_count</C>{' '}or <C>_msearch</C>{' '}and SQL <C>SELECT</C>{' '}are reads, while other POST, PUT, DELETE and PATCH
            requests are writes. On a connection marked <UI>Read-only</UI>, writes are refused in the app&rsquo;s main process and
            again in the driver, whichever view they come from.
          </P>
          <UL>
            <LI>
              Write buttons are enabled only with edit mode on (the lock button) and a writable connection. Disabled buttons
              say why in their tooltip.
            </LI>
            <LI>On a Prod-tagged connection every write asks first; elsewhere destructive ones do.</LI>
          </UL>
        </>
      ),
    },
    {
      id: 'indices',
      title: 'Index details and operations',
      body: (
        <>
          <P>
            Opening an index from its page shows tiles for documents, deleted documents, store size, shards (primaries and
            replicas) and status, and the tabs <UI>Mapping</UI>{' '}(field, type, multi-fields and properties), <UI>Settings</UI>,{' '}
            <UI>Aliases</UI>{' '}and <UI>Stats</UI>.
          </P>
          <DocTable
            head={['Operation', 'What it does']}
            rows={[
              ['Refresh', 'Makes recent writes searchable.'],
              ['Flush', 'Flushes the translog to disk.'],
              ['Clear cache', 'Clears the query, request and field data caches.'],
              ['Force merge to 1 segment…', 'Heavy I/O. Only for read-only indices.'],
              ['Close index… / Open index', 'A closed index cannot be read or written until opened again.'],
              ['Block writes / Allow writes', 'Sets or removes index.blocks.write.'],
              ['Reindex', 'Copies every document into a destination index you name.'],
            ]}
          />
          <P>
            <UI>New index…</UI>{' '}creates an index, and an index can be deleted from its row or page (it asks first). The cluster pages
            let you cancel a task, create a snapshot in a repository and restore a selected snapshot, and list index templates and
            their patterns.
          </P>
        </>
      ),
    },
    {
      id: 'health',
      title: 'Health advisor',
      body: (
        <P>
          <UI>Health</UI>{' '}in the icon rail shows read-only requests about the cluster: <UI>Cluster health and unassigned shards</UI>,
          <UI> Why shards are unassigned</UI>{' '}(the allocation explanation for each, also reachable from the Shards tab as{' '}
          <UI>Why is this shard where it is (or unassigned)?</UI>), <UI>Disk usage and watermarks per node</UI>{' '}and{' '}
          <UI>Hot threads</UI>. It reports a red cluster and a cluster that is not ready (HTTP 503) in plain words.
        </P>
      ),
    },
    {
      id: 'ai',
      title: 'AI on OpenSearch',
      body: (
        <P>
          The assistant writes query DSL or SQL for OpenSearch. With row data allowed on the connection it can run read-only{' '}
          <C>os_search</C>{' '}(first 50 hits) and <C>os_sql</C>{' '}requests to look at your data. See{' '}
          <Doc to="ai-assistant">AI assistant</Doc>.
        </P>
      ),
    },
  ],
};
