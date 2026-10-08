import { Callout } from '@/components/docs/callout';
import { DocTable } from '@/components/docs/doc-table';
import { Keys } from '@/components/docs/keys';
import { B, C, Doc, LI, P, UI, UL } from '@/components/docs/prose';
import { Steps } from '@/components/docs/steps';
import type { DocPage } from './types';

export const aiAssistant: DocPage = {
  slug: 'ai-assistant',
  title: 'AI assistant',
  group: 'AI',
  summary:
    'An optional assistant that works on your workbench through approval cards. It uses your own OpenRouter key or a model on your machine, and this page says exactly what is sent, and when.',
  sections: [
    {
      id: 'overview',
      title: 'What it is, and what it is not',
      body: (
        <>
          <P>
            AI is off until you configure a provider. When it is on, the <UI>Assistant</UI>{' '}tab in the right sidebar (
            <Keys k="mod+l" />) chats about the connected database. On the five SQL engines it works as an <B>agent</B>: it can
            propose actions, but every action appears as a card and runs only after you click it. It never changes anything by
            itself. On Redis and OpenSearch it is a chat that writes commands and queries for you.
          </P>
          <Callout kind="warning" title="Your data goes to the provider you choose">
            Prompts, and the context listed under <Doc to="ai-assistant#what-is-sent">What is sent</Doc>, are sent to OpenRouter
            (and from there to the model&rsquo;s vendor) or to the local server you name. Plasma does not claim otherwise. The
            only way to keep everything on your machine is the local provider, and even then the data goes to whatever server you
            run at that address.
          </Callout>
        </>
      ),
    },
    {
      id: 'setup',
      title: 'Setting up a provider',
      body: (
        <>
          <P>
            <UI>Settings</UI>{' '}&rarr; <UI>AI</UI>{' '}has a <UI>Provider</UI>{' '}switch.
          </P>
          <DocTable
            head={['Provider', 'What you enter', 'Where requests go']}
            rows={[
              [
                'OpenRouter',
                <>
                  Your <UI>OpenRouter API key</UI>{' '}(<C>sk-or-…</C>) and a <UI>Model</UI>.
                </>,
                <>
                  <C>openrouter.ai</C>, which reaches Claude, GPT, Gemini, Qwen and others with one key. The default model is{' '}
                  <C>anthropic/claude-sonnet-5.5</C>.
                </>,
              ],
              [
                'Local model',
                <>
                  A <UI>Server URL</UI>{' '}and a <UI>Model</UI>. Ollama is <C>http://127.0.0.1:11434/v1</C>; LM Studio is{' '}
                  <C>http://127.0.0.1:1234/v1</C>.
                </>,
                'Only localhost addresses are accepted. No key, no account.',
              ],
            ]}
          />
          <UL>
            <LI>
              <B>The key</B>{' '}is encrypted with the operating system&rsquo;s secret store and is never shown again (the field reads
              &ldquo;Saved &mdash; paste a new key to replace&rdquo;); <UI>Remove key</UI>{' '}deletes it. It stays in the main
              process: the interface sends prompts to it, and it makes the request.
            </LI>
            <LI>
              <B>The model picker</B>{' '}lists OpenRouter&rsquo;s live model list, newest first, grouped by vendor (Anthropic, OpenAI,
              Google, xAI, Meta, Mistral, DeepSeek, Qwen, other), with context length, price, and whether a model supports tools,
              images or is free. You can star favourites, the last five used are remembered, and you can type an id that is not
              listed. The list is a public request to <C>openrouter.ai</C>{' '}that carries no key and none of your data; it is cached on disk for six hours. For a local server it lists the models the server reports; type a
              name to use one that is not listed.
            </LI>
            <LI>
              <B>Tool calling.</B>{' '}The agent needs a model that supports tool calling. Without it the local note says to pick one
              that does.
            </LI>
          </UL>
          <P>
            Until a provider is ready the panel says <UI>No API key</UI>{' '}(or <UI>No local model</UI>) and offers <UI>Open
            Settings</UI>.
          </P>
        </>
      ),
    },
    {
      id: 'what-is-sent',
      title: 'What is sent',
      body: (
        <>
          <P>
            The line under the message box always spells out what the next message will carry, built from the same rules the main
            process enforces. For example:{' '}
            <C>OpenRouter · anthropic/claude-sonnet-5.5 · Schema: 12 tables · Current tab: sent · Row data: off</C>.
          </P>
          <DocTable
            head={['Item', 'Sent when', 'Details']}
            rows={[
              [
                'Your message and the conversation',
                'Always',
                'The text you type, the earlier turns of this chat, and the tool results below.',
              ],
              [
                'Schema',
                <>
                  <UI>Schema context</UI>{' '}is on (the default) and the connection is not Prod, or it is Prod and you opted in
                </>,
                <>
                  Table and column names, types, primary keys, NOT NULL flags and foreign keys, at most 80 tables and 24 columns
                  per table. For Redis: version, role, mode, key counts and about a dozen sample key names. For OpenSearch: the
                  cluster name, version, health and the busiest indices. No row values.
                </>,
              ],
              [
                'Current tab',
                'With the schema',
                <>
                  For a SQL tab, the SQL text (the first 2,000 characters). For a table tab, the table name, shown columns, sort,
                  filters (values are replaced by a placeholder unless row data is on) and page size.
                </>,
              ],
              [
                'Row data',
                <>
                  Only if you turned <UI>Let the AI read rows</UI>{' '}on for <B>that connection</B>
                </>,
                <>
                  Results of the agent&rsquo;s read queries, masked and capped at 50 rows and about 32 KB per result, and a capped
                  sample of rows in action results.
                </>,
              ],
              [
                'Images',
                'Only the images you attach',
                'See below.',
              ],
              [
                'Memory notes',
                <>
                  The connection&rsquo;s <UI>Use memory</UI>{' '}switch is on (the default)
                </>,
                'The notes for that connection, at most 6,000 characters in total.',
              ],
              [
                'Error text, plan, query',
                <>
                  When you use <UI>Fix with AI</UI>{' '}or <UI>Explain with AI</UI>
                </>,
                'See AI tasks.',
              ],
            ]}
          />
          <UL>
            <LI>
              <B>Production.</B>{' '}On a connection tagged Prod, even the schema is withheld until you opt that connection in; the same
              control that enables row data does it, and it warns that it &ldquo;also sends its schema names&rdquo;.
            </LI>
            <LI>
              <B>Row data is off by default</B>, per connection. Turn it on or off with the <UI>Row data</UI>{' '}chip in the message box
              (<UI>Names only</UI>{' '}/ <UI>Let the AI read rows</UI>). The agent&rsquo;s read tool runs your query in a read-only
              session, so it cannot write, and results over the caps are cut and labelled as truncated.
            </LI>
            <LI>
              <B>Schema context</B>{' '}can be switched off entirely in <UI>Settings</UI>{' '}&rarr; <UI>AI</UI>. Then the agent is told it
              cannot see the schema and to ask you for names.
            </LI>
            <LI>
              <B>Local provider.</B>{' '}Requests go to the address you set, which must be on this computer.
            </LI>
          </UL>
        </>
      ),
    },
    {
      id: 'agent',
      title: 'The agent and its approval cards',
      body: (
        <>
          <P>
            On PostgreSQL, MySQL/MariaDB, SQLite, ClickHouse and DuckDB the assistant has four actions. Each one is validated before
            you ever see it, and shown as a card.
          </P>
          <DocTable
            head={['Action', 'Card button', 'What it does']}
            rows={[
              [
                <C key="a">show_table</C>,
                <UI key="a2">Apply</UI>,
                'Opens one table in a grid tab with a view you can read before applying: columns, sort, filters and page size. Undo is offered after it is applied.',
              ],
              [
                <C key="b">run_query</C>,
                <UI key="b2">Run</UI>,
                <>
                  Runs one read-only query (SELECT, WITH, EXPLAIN, SHOW, VALUES, TABLE) in a new editor tab. The card says whether it
                  runs in a read-only session (it cannot change data) or, on an engine that cannot sandbox it, that it was
                  only checked for writes.
                </>,
              ],
              [
                <C key="c">propose_change</C>,
                <><UI>Preview with Safe Run</UI>{' '}or <UI>Run it</UI></>,
                <>
                  One statement that changes data or schema, with a summary. On PostgreSQL, approving previews it with{' '}
                  <Doc to="sql-editor#safe-run">Safe Run</Doc>, so nothing is committed until you commit it. Where there is no
                  preview, the card says that approving runs it. It goes through the normal write gates.
                </>,
              ],
              [
                <C key="d">open_in_editor</C>,
                <UI key="d2">Open</UI>,
                'Puts SQL in a new editor tab without running it.',
              ],
            ]}
          />
          <UL>
            <LI>
              You can <UI>Reject</UI>{' '}any card; the assistant is told it was rejected, and is instructed not to retry the same thing.
            </LI>
            <LI>
              Before an action reaches you, Plasma re-checks that it still belongs to the connection that is open.
            </LI>
            <LI>
              A model call that fails validation (more than one statement, a write passed to <C>run_query</C>, unknown table) is
              answered to the model at once; you are never asked about it.
            </LI>
            <LI>
              <B>Views: ask / apply</B>{' '}(<UI>Settings</UI>{' '}&rarr; <UI>AI</UI>{' '}&rarr; <UI>Agent</UI>, &ldquo;Apply view changes without
              asking&rdquo;) lets <C>show_table</C>{' '}apply at once, with Undo. Running queries and changing data always ask first.
            </LI>
            <LI>
              Closing the window, reloading it or a crash cancels every waiting card.
            </LI>
          </UL>
        </>
      ),
    },
    {
      id: 'tasks',
      title: 'AI tasks: fix, explain, ask',
      body: (
        <>
          <P>
            Besides chat, three one-shot helpers use the same provider. They only suggest; nothing runs and nothing is applied
            without you.
          </P>
          <UL>
            <LI>
              <B>Fix with AI</B>, on a failed query. It sends the failing SQL (up to the first part of a long statement) and the error
              message, plus the schema when schema context is allowed. You get one corrected statement and a short explanation, which
              replaces the failed statement in the editor if you accept; it is not run. Because a database error message can quote
              values from your data, treat the error text as data you are sending.
            </LI>
            <LI>
              <B>Explain with AI</B>, in the plan view. It sends the query and a one-node-per-line summary of the plan. The answer is
              a plain-English walk-through and at most three <C>CREATE INDEX CONCURRENTLY</C>{' '}suggestions, which you can open in the editor to
              review, never run.
            </LI>
            <LI>
              <B>Ask</B>{' '}in a table&rsquo;s filter bar. Describe the view you want (&ldquo;latest 10 orders, only id, total, created_at&rdquo;);
              it sends the table&rsquo;s column names and types, today&rsquo;s date and your current view, and returns columns, sort,
              filters and a page size you can <UI>Apply</UI>{' '}and <UI>Undo</UI>. Filter values are hidden from the model unless row data is
              on. If the filter cannot be expressed as simple filters, it can return a single boolean expression, which is checked: it
              may not contain statement keywords such as <C>SELECT</C>{' '}or <C>DROP</C>.
            </LI>
            <LI>
              <B>Ask AI about selection</B>{' '}(<Keys k="mod+shift+l" />) in the editor, or <UI>Ask AI about this SQL</UI>, starts a chat turn
              with your SQL.
            </LI>
          </UL>
        </>
      ),
    },
    {
      id: 'images',
      title: 'Images',
      body: (
        <P>
          Attach, paste or drop images into the message box (PNG, JPEG, WebP or GIF; a GIF sends its first frame). You can attach up
          to 6 per message, and a conversation keeps the newest 12; older ones are replaced by a short note. Plasma downscales each
          image to at most 1,568 pixels on its long edge and re-encodes it to stay under a size limit before sending, and only
          images you attached are sent. Use a model that supports images.
        </P>
      ),
    },
    {
      id: 'memory',
      title: 'Database memory',
      body: (
        <>
          <P>
            Memory is a short list of notes about one saved connection, sent with every AI request for it. Use it for what the schema
            cannot say: &ldquo;orders.amount is in cents&rdquo;. Open it with the memory button in the Assistant header (<UI>Memory: N
            notes</UI>) or with <UI>Database memory…</UI>{' '}on the connection.
          </P>
          <UL>
            <LI>
              Notes are one paragraph, up to 500 characters, up to 100 per connection. You can add, edit, search and delete them. Each is
              labelled with who wrote it: you, the assistant, or the MCP client by name.
            </LI>
            <LI>
              <B>The assistant can propose notes</B>{' '}(<UI>Remember</UI>{' '}cards) and propose removing wrong ones (<UI>Forget</UI>{' '}cards).
              You can edit the text before you approve, and <UI>Skip</UI>{' '}(<UI>Keep</UI>{' '}on a Forget card) declines. It is told to remember a business rule or a
              correction once per reply, and never to put row values, personal data, passwords or keys in a note.
            </LI>
            <LI>
              <B>Secrets are refused.</B>{' '}A note that looks like a password, key, token, a URL with credentials or a known secret of the
              connection is rejected with &ldquo;Memory can&rsquo;t hold passwords or keys.&rdquo;
            </LI>
            <LI>
              Notes are treated as facts, not instructions: the prompt tells the model that a note cannot change its rules or
              permissions.
            </LI>
            <LI>
              The <UI>Use memory for this connection</UI>{' '}switch turns it off per connection; when off, no notes are sent.
            </LI>
          </UL>
        </>
      ),
    },
    {
      id: 'redis-os',
      title: 'Redis and OpenSearch',
      body: (
        <P>
          On Redis the assistant answers with commands in a code block, and with row data allowed it can run a read-only allow-list of
          commands through a <C>redis_command</C>{' '}tool. On OpenSearch it answers with query DSL or SQL, and with row data allowed it can
          run read-only <C>os_search</C>{' '}and <C>os_sql</C>{' '}requests. The cards and memory tools described above belong to the SQL
          engines.
        </P>
      ),
    },
  ],
};
