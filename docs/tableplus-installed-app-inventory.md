# TablePlus — installed macOS app feature and UI inventory

## Scope and evidence

Inspected directly through macOS Computer Use: **TablePlus 26.10.22 (802)**, as displayed in About and the connection manager. The app was in its free-trial state, with an existing PostgreSQL workspace and a metrics workspace open.

This is an inventory of the installed application, not a proposed Plasma implementation. Following the user's explicit authorization, the saved **Resilinc Admin → resilincscrm** connection was opened and its PostgreSQL 18.6 workspace inspected over TLS 1.3. Table browsing and administrative viewers perform read queries automatically; no user-authored SQL or mutating query was run, no connection was saved, and no database changes were committed. Existing query contents, credentials, server addresses, and business records are deliberately omitted from this report.

Safety note: the diagram's Add Table action produced an unsaved CREATE TABLE draft. Its SQL preview was inspected and the draft discarded. The final workspace showed no pending changes. No permission changes, imports, restores, process termination, plugin installation, or AI submissions were performed. No application source code was changed.

Evidence labels:

- **Observed:** a control, menu entry, setting, or screen was visible in the installed app. This establishes availability, not successful end-to-end execution.
- **Documented, pending native verification:** present in the official documentation reviewed earlier, but not verified in the installed version.
- **Not executed:** a workflow was inspected but its effectful action was deliberately not submitted.
- **Limited:** the free-trial two-tab warning and some inconsistent native accessibility actions prevented exhaustive nested-control testing. The earlier private-record approval blocker was resolved by the user's explicit instruction to inspect this database.

## 1. UI anatomy — observed

```text
macOS menu bar
TablePlus · File · Edit · View · Tools · Connection · Theme · Navigate · Window · Help
┌────────────────────────────────────────────────────────────────────────────┐
│ Toolbar: navigation · changes · safe mode · database · SQL · status · tools│
├──────────┬────────────────┬─────────────────────────────┬─────────────────┤
│Workspace │ Items          │ Object / SQL tabs           │ Details         │
│rail      │ Queries        ├─────────────────────────────┤ Assistant       │
│          │ History        │ SQL editor OR table view    ├─────────────────┤
│Database  │ Search         │                             │ Search fields   │
│Metrics   │ Object/query   │                             │ Row details /   │
│          │ hierarchy      ├─────────────────────────────┤ AI conversation │
│          │                │ Editor settings / run tools │                 │
│          │                ├─────────────────────────────┤                 │
│          │                │ Result tabs                 │                 │
│          │                │ Result content              │                 │
│          │                ├─────────────────────────────┤                 │
│          │ Add / options  │ Data · Message · Chart       │                 │
│          │                │ Timing · pin · find · export│                 │
└──────────┴────────────────┴─────────────────────────────┴─────────────────┘
```

### Visual treatment

- Native macOS window controls, menus, sheets, toolbars, segmented controls, popovers, and resizable split regions.
- Current appearance follows the system theme and is dark: charcoal surfaces, fine dividers, compact controls, muted gray labels, and bright blue selected segments.
- Monospaced SQL and data, small system UI labels, syntax colors differentiated by token type.
- A prominent, color-coded connection status capsule across the toolbar displays engine/version, transport security, connection, database, and active object/file.
- Narrow workspace rail at the far left; a separate wider object/query sidebar next to it. Workspaces and object tabs are distinct navigation levels.
- Central editor dominates available space. Results sit below it with a horizontal splitter and independently selectable result tabs.
- The right sidebar switches between Details and Assistant. Details has field search and an explicit “No row selected” state.
- Toolbar commands use icons; tooltips and accessibility labels expose their purpose. A visible toolbar grouping contains discard/preview/commit actions.
- Query controls sit at the editor's bottom edge: result limit, Beautify, and Run Current dropdowns. Cursor line/column/location appears at the opposite edge.
- Result footer combines Data/Message/Chart modes, execution time, result status, pinning, search, and Export.

## 2. Connections and engines — observed

### Connection manager

- Saved connections in an outline list, connection search, and an add button.
- Create Connection, Backup Database, and Restore Database entry points.
- Free-trial indicator, Purchase, Activate, and version display.
- New-connection sheet: engine grid, search, Create, Import Connection, New Group, Cancel.
- Connection menu: New, Edit, Open a Database, Open a Connection, Reconnect, Disconnect, Reload Workspace, Reload Current Tab.

### Engine choices in the installed picker

| | | |
|---|---|---|
| PostgreSQL | Amazon Redshift | MySQL |
| MariaDB & SingleStore | Microsoft SQL Server | Cassandra |
| ClickHouse | BigQuery | DynamoDB (Beta) |
| Elasticsearch | LibSQL | Cloudflare D1 |
| Mongo | Snowflake | Redis |
| SQLite | DuckDB | Oracle |
| Cockroach | Greenplum | Vertica |

The labels above are exactly the product choices visible in the picker. They do not imply feature parity across engines; only the PostgreSQL form was inspected.

### Blank PostgreSQL connection form

- Name, status color, environment/tag controls.
- Host/socket, port, user, password, database.
- Password-storage selector showing Store in keychain.
- SSL mode selector: PREFERRED, DISABLED, REQUIRED, ALLOW, VERIFY-CA, VERIFY-FULL.
- SSL key, certificate, CA certificate selectors and clear action.
- Negotiation selector, displayed as POSTGRES.
- Over SSH entry point.
- Bootstrap commands executed after connection establishment.
- Additional options entry point.
- Separate Test, Save, and Connect actions.

Only this empty form was inspected; no credentials were entered and none of these actions were submitted.

## 3. Workspaces, panes, and navigation — observed

- Multiple native workspace tabs, including database and metrics workspaces.
- Multiple object/query tabs within a workspace.
- New Workspace, New SQL Viewer, New Tab, Close Tab, Close Other Tabs, Close Window, Close All.
- Open SQL files, recent-file menu, Save As.
- Open Anything launcher.
- Back/forward navigation.
- Next/previous pane, tab, and workspace; direct selection of tabs 1–9.
- Split Pane Right command and an editor Split Right button.
- Show Table Data and Show Table Structure commands.
- Toggle left sidebar, right sidebar, bottom sidebar, and query-results pane.
- Show All Tabs, fullscreen, move tab to new window, merge windows when applicable.
- Native window tiling, centering, sizing, and display movement commands.

## 4. Left sidebar — observed

- Three top-level modes: Items, Queries, History.
- Queries has search, an expandable folder hierarchy, an Ungrouped section, query files, add, and options controls.
- Separate SQL Query settings button.
- Workspace rail shows database and metrics destinations.

### Items and history — verified inside Resilinc

- Namespace selector displaying public; expandable Functions and Tables sections, object-type icons, and item search.
- Matching strategies: Fuzzy and Contains.
- Sidebar settings: show recently, functions, sequences, and table columns; sort columns by name or ordinal; load system schemas; lazy-load schema items.
- Table context menu: Open in New Tab, Open Structure, Item Overview, Show Diagram, Copy Name, Pin to Top.
- Export Tables; Export this Table with Column Selection; import CSV, JSON, or SQL dump.
- New Table, View, Function/Procedure, Materialized View, and Group.
- Copy Script As: Creation, Drop, Truncate, Select Top 100.
- Clone, Truncate, and Delete commands. These were not submitted.
- History search and a setting to log original values when updating or deleting data. That setting was not changed.

Query-folder management and history replay were not exercised.

## 5. SQL editor — observed

### Editing and execution

- Syntax-highlighted text, line numbers, cursor position, scrollbars, and resizable result area.
- Run Current and Run All commands; configurable keyboard shortcuts.
- Beautify action and dropdown.
- Result-limit dropdown displaying No limit.
- Find, Find and Replace, Find Next/Previous, use selection for find, jump to selection.
- Toggle line/block comment, select word/all words, font-size increase/decrease.
- Standard undo/redo, cut/copy/paste, select-all, and text transformations; availability depends on focus.

### Editor options menu

- Font sizes from 9 through 48, including common intermediate choices.
- Show invisible characters, wrap to editor width, highlight current query.
- SQL-tab restoration policies: do not save, save first tab, save all tabs.
- Sublime default or Vim keybindings.
- Autocomplete categories: tables, functions, keywords; disable suggestions.
- Automatic whitespace, schema prefixes, uppercase keywords, closing braces and quotes.
- Query parameters, optional variable search inside quoted strings, parameter-format configuration.
- Result mode: split results into tabs or append all results in one tab.
- Return on Error option.

### Global editor settings

- Completion key preference, displayed as Enter or Tab.
- Spaces/tabs, indentation width, indentation type.
- Automatic saving while editing, uppercase completion, closing brackets/quotes.
- Variable format selector displayed as Colon `:name` with a sample query.

## 6. Results and data editing — observed controls

- Multiple result tabs were visible for an existing multi-statement query.
- Data, Message, and Chart result modes.
- Execution status and duration in milliseconds.
- Export action, search within results, and pin-to-keep-result control.
- Details sidebar with field search and no-selection state.
- Edit menu exposes Commit, Discard, Preview, Add Row, Duplicate Rows, Copy Selected Cells, Paste to Selected Cells, and Delete. Row-specific commands were disabled in the active message view.
- Table appearance preview demonstrates a grid with sortable headers, horizontal scrolling, and an “Expand columns to fit content” control.

### Table data UI — verified inside Resilinc

- Data / Structure / Index segmented navigation along the lower edge.
- Compact striped grid, row-number gutter, horizontal scrolling, blue selection outline, truncated inline JSON, and foreign-key arrows inside cells.
- Expand columns to fit content; visible row-range/count indicator; Add Row control.
- Previous/next page; Page Settings popover with Offset, Limit, and Go. The inspected limit was 300.
- Columns popover with column selection, Add a Column, Apply, and Clear.
- Details pane shows table total/data/index sizes and comment when appropriate. Selecting a row reveals per-field names/types, editable text controls, formatted multiline JSON, boolean/enum selectors, and field search.
- Edit menu exposes Add Row, Duplicate Rows, Copy Selected Cells, Paste to Selected Cells, Delete, and Commit/Discard/Preview. Availability varies with focus.

### Filters — inspected, not applied

- Per-condition column/expression selector, operator/value, Apply, remove, clone, and enabled checkbox.
- Raw SQL filter option; Apply All dropdown; Clear; generated SQL preview; export filtered results.
- Defaults: column ordering by name/ordinal; initial column Primary Key/Any/Raw SQL; operator Equals/Contains; remember/show/hide filter state; table sorting none/primary-key ascending/descending.
- Keyboard hints: show filter ⌘F; insert ⌘I; remove ⇧⌘I; apply all ⌘Return; move conditions ⌘↑/↓; columns/operators ⌘←/→; enable/disable ⌘B; exit Escape.

### Structure, indexes, and triggers — verified

- Structure view exposes table name, primary-key token field, column search, Add Column, types, nullability/defaults, references, and other column metadata.
- DDL and Triggers entry points. Trigger viewer has name, event, timing, statement, SQL area, and Add Trigger. Existing BEFORE/AFTER and INSERT/UPDATE trigger metadata loaded.
- Index grid columns: index_name, index_algorithm, is_unique, column_name, condition, include, storage_parameters, comment.
- Add Index; index context menu offers New Index, Duplicate, Paste, Paste to Selected Cells, Copy Rows, Copy Selected Cells, and Delete.
- Copy Rows As / Copy Selected Cells As formats observed: Plain Text, JSON, HTML, Markdown Table, CSV, CSV with Header.

No table/column/index/trigger changes were saved. Cell-specific context menus, BLOB quick editors, foreign-key traversal, and bulk-edit execution remain untested.

## 7. Import, export, backup — observed entry points

- Import from CSV, JSON, and SQL Dump.
- Export Tables and Export this Table with Column Selection; table selection is required.
- Export query results from the result footer.
- Backup and Restore from both the File menu and connection manager.
- Configurable CSV delimiter, quoting, line break, and decimal behavior in General settings.
- Preference to show a containing-folder popup after export.

These are UI availability observations. File transfer and backup/restore execution were not tested.

Backup setup was opened: connection/database lists with independent search, PostgreSQL tool-version selector (displayed PostgreSQL 18.0 after selecting the connection), option tokens (default --format=custom), Add Option, filename, Customize, Gzip compression, and Start Backup. Restore setup exposes connection/database selection and search, tool version, options, New Database, and Start Restore. Neither Start action was clicked. Detailed export mappings and backup option submenus remain unverified.

## 8. Database and developer tools — observed menu entries

- Process List.
- Show Diagram.
- Show Metrics Board; an existing metrics workspace was visible in the workspace rail/tab bar.
- User Management.
- Search in Database.
- Run Custom Script.
- Manage Plugins.
- Console-log panel toggle.
- SSH and Bash script logging entry point in Help.
- Connection-specific character encoding selection: Default, UTF-8, EUC variants, ISO-8859 variants, KOI8, LATIN variants, and Windows code pages.

### Process list

Loaded the live process list. Columns include datname, pid, leader_pid, usename, application_name, client_addr, client_port, query_start, state, query_id, and query. Controls: Refresh, Kill, Dismiss. Kill was not used; private process/query contents are omitted here.

### PostgreSQL user management

The installed version does expose User Management for this PostgreSQL connection. A user/role outline, New User, Apply, and Cancel are present. Selecting an existing role revealed:

- General: username/password fields.
- Global Privileges: create databases, superuser, streaming replication/backup, bypass row-level security.
- Table Privileges: schema/table tree, available/granted privilege lists, and transfer arrows.

No credentials or grants were edited; the dialog was cancelled.

### Search in Database

Sidebar search mode has a search field, Search All Items / Select Items scope, operator selector, Start Search, and Done. Observed operators: =, <>, <, >, <=, >=, IN, NOT IN, IS NULL, IS NOT NULL, BETWEEN, NOT BETWEEN, LIKE, ILIKE, Contains, Not Contains, case-insensitive Contains/Not Contains, prefix/suffix and their case-insensitive variants. No database-wide content search was started.

### Diagram

A dedicated workspace with scrollable canvas, schema selector, table search, Undo/Redo, Sort and Layout, Add Table, Rearrange, Zoom Out/Reset/In, and Show Workspace. Sort offers Name and Column Count. Add Table creates a draft schema object, not merely a selector for existing tables: the inspection-created draft was discarded. The trial displayed a two-tab limit warning; populated relationship rendering and further editing were not verified.

### Metrics board

Dedicated workspace with a query-search/sidebar hierarchy and a large dotted-grid canvas. Toolbar controls expose Add Metric Object, lock/unlock board, show workspace, start/stop data refresh, and toggle grid. The inspected board was empty. Chart configuration and refresh behavior were not tested.

### Custom scripts and plugins

Custom Script opens a separate window with a line-numbered editor above an output pane, a workspace selector, and a Run control. No script was entered or run.

Plugin Manager lists Diagram Generator 4.0, UUID Generator 2.1, SQL Formatter 1.0, Dump Table 1.3, and Open URL 1.0. An expanded plugin menu exposed Install and Website. Nothing was installed.

A visible control establishes availability in this installation, not successful execution or parity across database engines.

## 9. Safety and security — observed

- Dedicated Safe Mode toolbar control.
- Commit/Discard/Preview commands for reviewing pending GUI changes.
- Security settings describe password confirmation before sending queries when Safe Mode is enabled.
- Default Safe Mode policy for new connections.
- Optional Touch ID unlock for Safe Mode.
- Optional application passcode, Touch ID unlock, away-time auto-lock, and change-passcode control.
- Password-storage and SSL configuration in connection form.
- Existing connection status displayed TLS protocol information.

Security settings were read without alteration. Other than the visible default Silent Mode label, per-mode choices were not reopened in this pass.

## 10. Assistant / LLM Agent — observed

- Assistant tab on the right sidebar, configurable in settings.
- Settings describe asking AI to write queries.
- Provider list: OpenAI, Anthropic, Google AI, OpenRouter, DeepSeek, GitHub Copilot, Codex CLI, Ollama.
- Add-provider control.
- Selected provider form: name, host, subpath, masked API key, default model, default-vendor checkbox.

No prompts were sent and no data-sharing or query-execution behavior was tested. Older documentation's claims about AI permissions should not be assumed to describe this newer installed build.

## 11. MCP — observed

- Enable MCP Server control; server was stopped during inspection.
- Preferred-port setting.
- Optional remote access over TLS and certificate export.
- Client setup choices: Codex, Claude Code, Manual, HTTP Server.
- Local executable configuration for `tableplus-mcp`.
- Access-token list with Name, Prefix, Permissions, Status, Created, Last Used.
- Add, Delete, Revoke, and Activity controls.
- Connected-client count and server status.
- Automatic token-generation option with on-screen explanation of token lifecycle.
- Approval-needed-for-unsafe-query option, with a note that connection Safe Mode may require another confirmation.

The MCP server remained stopped; no access tokens or certificates were created.

## 12. Settings and visual customization — observed

Settings is a dedicated native window with nine toolbar sections:

| Section | Visible capabilities |
|---|---|
| General | Beta updates, workspace restoration, automatic update/notification preference, language, CSV defaults, new-tab behavior, query timeout, keepalive, crash reports |
| Table | Auto-hide scrollbars, alternating row colors, estimated-count threshold, export-folder popup, automatic PostGIS-to-WKT conversion |
| Editor | Completion, indentation, autosave, capitalization, closing pairs, keybindings, query parameters |
| Fonts & Themes | Theme list, SQL/data/application categories, font and size controls, color editors, previews, add theme, restore defaults |
| Security | Safe Mode defaults, Touch ID, passcode, auto-lock |
| Locations | Configurable locations for connections/groups, queries/history, and filters/layout/temp files; private-cloud folder explanation |
| Keymap | Rebind navigation, panes/workspaces/tabs, table data/structure, comments, font size, current/all-query execution |
| LLM Agent | Providers, endpoint, credentials, model, default vendor, Assistant visibility |
| MCP | Server, clients, remote TLS, tokens, approvals, activity |

### Themes and colors

- Auto, Light, Dark.
- Built-in Silver Dark, Jade Dark, Polaris Dark, Sunset Dark, Sunset Light.
- Import theme from Git; import themes from file or folder.
- SQL editor preview, font size and line height.
- Token colors for comments, numbers, string/identifier quoting styles, keywords, identifiers, functions, default text, JSON keys.
- Background colors for current query, selection, errors, matching brackets; invisible-character color.
- Data-table preview, font size and padding.
- Grid separators, odd/even rows, row numbers, inactive selections, cell arrows, placeholders, selection border.
- Distinct deleted/modified/inserted content colors.
- Type-specific text colors, column-header colors, row-detail colors, geometry outline, polygon fills.
- Application appearance category was visible; its individual controls were not enumerated.

## 13. Keyboard controls directly visible in the app

| Action | Shortcut shown |
|---|---|
| Run current query | ⌘ Return |
| Run all queries | ⇧ ⌘ Return |
| Beautify | ⌘ I |
| Toggle row detail | Space |
| Toggle console log | ⌃ ⌘ C |
| Next/previous pane | ⌥ ⌘ ] / [ |
| Next/previous workspace | ⌘ ] / [ |
| Next/previous tab | ⇧ ⌘ ] / [ |
| Table data/structure | ⌃ ⌘ [ / ] |
| Line/block comment | ⌘ / and ⌥ ⌘ / |
| Increase/decrease font | ⌘ = / - |

These reflect the installed configuration, which supports rebinding. Other documented shortcuts were not substituted for observed values.

## 14. Documented features still requiring native verification

The following complete the broader feature checklist but must not be confused with features tested during this installed-app inspection:

| Area | Documented workflow to verify |
|---|---|
| Connection organization | Groups, drag/drop organization, connection URL import/copy, protected connection-file import/export, environment tags |
| Table browsing | Item-overview details, count-estimate behavior; data/structure/index views, paging and column controls are now observed |
| Object editing | End-to-end create/rename/drop/truncate and constraint workflows; structure/index/trigger controls are now observed, not committed |
| Other objects | Functions, procedures, views and their definitions |
| Cell and row workflows | Inline editing, bulk edits, duplication, quick look for JSON/BLOB, foreign-key navigation, staged changes |
| Clipboard | Actual clipboard output and SQL/column formats; index-row text/JSON/HTML/Markdown/CSV menus are observed |
| Filters | Applying combinations and column/value quick filters; builder, raw SQL and preview/export controls are now observed |
| Queries | Multi-cursor behavior, favorites, keyword bindings, folders, reusable history, parameter prompts |
| Loading | Streaming results and background loading behavior |
| Metrics | SQL-backed bar/line charts and tables, refresh intervals/events, input variables |
| Plugins | Installation and plugin-specific execution; catalog and install controls are now observed |
| Backup/import/export | Detailed format options, mappings, validation, cancellation, progress, error recovery |

Official reference sources for this pending checklist: [interface](https://docs.tableplus.com/gui-tools/the-interface), [connections](https://docs.tableplus.com/gui-tools/manage-connections), [tables](https://docs.tableplus.com/gui-tools/working-with-table), [filters](https://docs.tableplus.com/gui-tools/filter), [import/export](https://docs.tableplus.com/gui-tools/import-and-export), [editor](https://docs.tableplus.com/query-editor/untitled), [metrics](https://docs.tableplus.com/gui-tools/metrics-board). These pages can lag the installed version.

## Coverage and remaining limitations

This pass inspected the installed app's main menus/settings and the authorized Resilinc connection's data, structure, indexes, trigger viewer, filter builder, column/paging controls, row details, object/index context menus, process list, role/privilege UI, database-search controls, diagram/metrics shells, custom-script window, plugin catalog, and backup/restore setup.

It is a feature/UI inventory, not an exhaustive behavioral certification. Destructive operations, actual imports/restores/exports, permission changes, live editing/commit workflows, AI/MCP submissions, every engine-specific feature, and every nested contextual option were not executed. The free-trial tab warning and occasional native-window focus/accessibility inconsistencies also limited inspection. No further permission is needed for the read-only Resilinc inspection already authorized; a disposable database would be appropriate for future write-workflow testing.
