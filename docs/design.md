# yadbc — design (v1)

*Yet another database client.* A personal, fast, uncluttered PostgreSQL client.
Status: v1 built and in daily use; this document records the decisions behind it.

Source material: [ui-debate-verdict.md](ui-debate-verdict.md) (the UI/UX rulings, with overrides listed in §11).

## 1. Goals and non-goals

**Goals**
- Fast: first rows on screen in milliseconds, a grid that scrolls at 60 fps, a quick start.
- Uncluttered: no toolbar wall. Every action is easy to find through the palette, menus and tooltips, and nothing important is buried. Export as INSERT is one click.
- Daily loop: ad-hoc queries and data edits on dev databases. Also schema browsing, EXPLAIN, and activity and locks.
- Looks like 2026, in light and dark.
- Safe enough on prod without being a bother.

**Non-goals for v1**
- Engines other than PostgreSQL. SQL Server and MySQL may come later, but no engine abstraction until the second engine exists.
- Any server component or deployment for the app itself: everything runs on the local machine. Shared connections (§10b) are an optional add-on with its own small broker.
- An in-app AI chat. MCP comes first, as a late v1 item (see §10).

## 2. Architecture

```
┌──────────────────────── yadbc.exe (one process) ───────────────────────┐
│  Photino window (WebView2 on Windows)                                   │
│     └─ Angular app (static files served by Kestrel)                     │
│            │  HTTP + one WebSocket, per-launch token                    │
│  Kestrel on 127.0.0.1:<random>                                          │
│     ├─ Connections   profiles, keychain, tunnels (ssh / kubectl)        │
│     ├─ Catalog       schema introspection (pg_catalog), autocomplete    │
│     ├─ Query         sessions, execution, result buffers, edits, export │
│     ├─ History       SQLite: query history, app state                   │
│     ├─ Activity      sessions, lock waits, cancel / terminate           │
│     └─ Mcp           MCP endpoint over the same services                │
└─────────────────────────────────────────────────────────────────────────┘
          │ Npgsql (direct, or via a local ssh -L / kubectl port-forward)
          ▼
      PostgreSQL
```

- **The desktop window comes first.** One .NET process starts Kestrel and opens a Photino window pointing at it, so there is no browser tab. That frees the browser-reserved shortcuts (Ctrl+W/T/Tab/J…), and no other web page can reach the backend.
- **One modular monolith.** Modules are split by domain, as above, not by technical layer. Each module owns its endpoints, services and storage. They talk through plain C# interfaces in-process.
- **The frontend is Angular (zoneless)** with Angular CDK for behaviour and Tailwind for styling. No Angular Material. RxJS handles async orchestration; signals are used only at the template boundary.

### Localhost hardening
1. Kestrel binds `127.0.0.1` only, never `0.0.0.0`.
2. A random token is generated at each launch and required on every HTTP and WebSocket request. The window gets it at startup; MCP clients get it from the printed `claude mcp add …` line.
3. Requests whose `Host` header is not `127.0.0.1:<port>` / `localhost:<port>` are rejected (DNS-rebinding defence).

## 3. Connections

- **Profile** = non-secret config in `%APPDATA%\yadbc\connections.json`: name, host, port, database, user, environment (`local` / `dev` / `prod`), Claude (MCP) access, and an optional tunnel (SSH or Kubernetes, below).
- **The password** lives only in the OS's secret store — Windows Credential Manager, or on Linux the desktop keyring through libsecret's `secret-tool` (GNOME Keyring, KWallet; the secret goes through stdin, never the command line) — referenced from the profile by id. There are no secrets in config files, so the folder is safe to back up or sync. Profile and credential are deliberately separate so a future sharing broker can plug in as just another credential source.
- **Tunnels** reach a database that isn't directly reachable. yadbc runs the user's own tools as child processes rather than re-implementing them, so their auth comes along:
  - **SSH:** `ssh -N -L 127.0.0.1:<local>:<host>:<port> [-p] [-i] [user@]server`, using Windows OpenSSH (`System32\OpenSSH\ssh.exe`), so the Windows / 1Password SSH agent and `~/.ssh/config` (aliases, ProxyJump) work. The profile's host and port are as the SSH server sees them. `BatchMode=yes` means it never waits on an invisible prompt: an untrusted host key or a missing key fails with a message saying what to do.
  - **Kubernetes:** `kubectl [--kubeconfig] [--context] [--namespace] port-forward --address 127.0.0.1 svc/x <local>:<port>`, so it uses the user's kubeconfig and RBAC. The profile's host is ignored and the port is the one on the target. The dialog suggests kubeconfig files from `~/.kube`, their contexts, and, once a context is chosen explicitly, namespaces and services. Opening the dialog never queries whichever cluster happens to be current.
  - **Lifecycle:** one tunnel per connection, started on first use, on a local port fixed for the app's lifetime (so pooled connections and open tabs keep a stable endpoint). Ready means the local port accepts connections; if the process exits first, its stderr is mapped to a readable error. A tunnel that died (VPN drop, laptop sleep) is restarted on the next use. A tab whose tunnel died reconnects *before* the next run and says that session state and any open transaction are gone, instead of failing the run. Editing or deleting the connection stops its tunnel. On Windows the processes sit in a Job Object with KILL_ON_JOB_CLOSE, so they die with yadbc even on a crash. On Linux they're stopped on a normal exit; after a crash a tunnel process can outlive yadbc. "Test" on unsaved settings uses its own short-lived tunnel.
  - `YADBC_SSH`, `YADBC_KUBECTL` and `YADBC_SSH_OPTIONS` override the executables and add ssh options, for tests and unusual installs.
- **Groups:** a connection can sit in a group of your own ("CMDB"), which is personal, also for installed shares. Groups organize the switcher and start list (each group local → dev → prod, ungrouped last; names match case-insensitively), the Compare pickers and Ctrl+P (a group name finds its connections). *Compare schema with…* starts on a sibling in the same group: prod, or dev when you're on prod. There is deliberately no shared "system" on the broker: grouping is how each person organizes their own list.
- **Editing a connection reaches its open tabs** (also a shared one changed by its owner, on sync): titles, the switcher and the status bar follow a rename. If the host, port, database, user or tunnel changed, editor tabs reopen their session (open transactions roll back) and the schema reloads, so a tab never shows one database while querying another.
- **Environment colour** (green local, amber dev, red prod) appears on the connection, as a 2px top edge plus a dot on every tab bound to it, and on red as a 2px inset frame around the editor and results.

## 4. Query execution

### Sessions
- **Every editor tab owns one dedicated `NpgsqlConnection`** (not borrowed from the pool per query). Transaction state, `SET`, temp tables and `search_path` are per session, and per tab is how you think about them.
- Catalog and autocomplete queries use a separate pooled connection, so they never interfere with a tab's transaction.
- A tab is bound to exactly one connection and never switches it silently.

### Running
- **Ctrl+Enter** runs the statement under the cursor. **Ctrl+Shift+Enter** runs the selection, or the whole script if nothing is selected. A gutter bar marks what will run.
- **Statements** end at a `;`, or at a blank line followed by a statement keyword (SELECT, INSERT, UPDATE, WITH, CREATE…): scratch files often have no `;` between queries. A blank line doesn't end a statement that isn't finished — inside parentheses, a WITH before its SELECT, an INSERT before VALUES / SELECT, an UPDATE before SET, an EXPLAIN before its statement, or after a trailing AS / UNION / AND / comma / operator — so long statements with blank lines in them stay whole. Strings, comments and `$$` bodies are skipped. Autocomplete uses the same boundaries.
- Statements are split by a lexer that understands strings, comments and `$$` dollar quoting, not a full parser.
- **Cancel:** the Run button turns into `Cancel · 3.2s`, or press Esc twice. This sends a protocol CancelRequest through the Npgsql cancellation token. If the backend is still busy after 5 s, the button offers **Terminate backend**, which runs `pg_terminate_backend(pid)` on a second connection.
- **Transactions:** autocommit is the default. A per-connection setting switches to manual. While a transaction is open, `IN TX 00:42 · Commit · Rollback` appears in the tab strip, and closing the tab asks Commit / Rollback / Cancel.

### Result buffer
- The backend **reads the whole result as fast as possible into memory**, then releases the reader. Holding a cursor open while you look at the grid would leave the session `idle in transaction`, holding locks that block other people's DDL and vacuum.
- **Default cap: 10,000 rows**, configurable. A capped result says so: `10,000 (capped) · Fetch all`.
- The first batch is pushed immediately and the rest keeps streaming in, so rows appear within milliseconds.
- The UI **requests windows** (`rows 4200–4300, cols 0–25`) over the WebSocket. The browser never holds the whole result. Sorting by header sorts the backend buffer without running the query again.
- Scripts with several statements produce several result sets. A non-SELECT yields `UPDATE 42 · 12 ms`.

### Values on the wire
- `int8`, `numeric` and `money` go as strings, never JS numbers. Precision above 2^53 would otherwise corrupt IDs, and editing could hit the wrong row.
- NULL and `''` are distinct on the wire and on screen.
- The buffer stores full values (safety limits: 1 MB per cell, 256 MB per result; beyond that the result is capped like the row cap). Grid windows cut values to 500 characters; the inspector and copy fetch them untruncated.
- `timestamptz` is shown in local time with its offset.

### Errors and notices
- `PostgresException` → an error card with SQLSTATE, message, DETAIL, HINT and CONTEXT, plus a red squiggle in Monaco at `Position`. Clicking the card jumps to that position.
- NOTICE and WARNING (Npgsql `Notice` event) go to a Messages chip in the results header, with a severity-coloured count. They never appear as toasts.

### History
- SQLite at `%APPDATA%\yadbc\yadbc.db` (WAL): one entry per **executed** statement — connection, SQL, start time, duration, rows (returned or affected), outcome (ok / error with message / cancelled) and kind (run, explain, explain analyze, grid edit — the exact applied script). Statements after a failure aren't recorded; they never ran.
- Recorded through a queue drained by a background task: history never adds latency to a query. The oldest entries past 50,000 are pruned.
- Sidebar **Schema · History** switch; History lists the active connection's statements, newest first, with case-insensitive search and paging on scroll. It refreshes after each run.
- Double-click: open in a new tab. Enter: append to the current editor and select it (nothing you wrote is replaced). Alt+Enter: new tab. Context menu: run in new tab, copy, delete. Ctrl+P search across history comes with the command palette.
- The same file will store app state (open tabs, layout, saved queries) later.

### Parameters and snippets
- **`:name` parameters.** Run or explain a statement containing `:customer_id` and a dialog asks for each value first. A scanner (not a parser) finds them outside strings, quoted identifiers, comments and dollar quotes; `::casts` and array slices (`a[lo:hi]`) are not parameters.
- Each value is one of: **Value** (default), a quoted literal that Postgres casts to the type the context needs, so `'42'` works for an `int8` id; **NULL**; or **SQL**, pasted as-is, for `in (:ids)` ← `1, 2, 3` or `now() - interval '1 day'`. Nothing is guessed from the text: typing `null` into Value means the string `'null'`.
- Bound client-side into plain SQL, so the history entry is what ran. The values are remembered **per tab** (saved with the workspace). The dialog opens with the last values and the first one selected, so Enter re-runs. Error positions after a substituted value can be off by the length difference.
- A data tab opened with parameters (history "Run in new tab") waits for Run instead of running unbound.
- **Snippets:** saved, named statements in `snippets.json`, saved and deleted one at a time so two windows can't drop each other's. Each snippet is either for one connection or for every connection. Save the statement under the cursor with the Snippets tab's **+** or Ctrl+K → *Save statement as snippet…*; the dialog sets the name and scope.
- The sidebar's **Snippets** tab (beside Schema and History) and Ctrl+P (its own section) list them. Enter/click appends to the editor, double-click opens a new tab, and the context menu has rename or move, copy and delete. A snippet with `:params` is the reusable query: insert, run, fill in.
- **Shared snippets** (signed in to the broker, §10b): share one from its context menu or with the save dialog's *Share* box. It's marked with the sharer's initials.

## 5. Results grid

**Our own grid**, a hand-written imperative renderer running outside Angular change detection. AG Grid is ruled out because range selection and clipboard are Enterprise-only.

- Fixed 24px rows. Rows **and** columns are virtualised, using a recycled pool of row and cell elements and precomputed column offsets. On scroll it writes only `textContent` and `transform`.
- Column widths are estimated from the first batch, measured in the mono font. That font is preloaded with `font-display: block`, so the measurements are never wrong.
- Two-line column header: the name, then the type in small mono (`int4`, `jsonb`) plus marks for PK, FK and NOT NULL.
- Range selection; **Ctrl+C** copies TSV, which pastes into Excel. Selection aggregates (count/sum/avg/min/max) are computed on the backend and shown in the status bar.
- Values don't lie: NULL is a dim italic `null`, an empty string is a faint `''`, leading and trailing whitespace is visible, booleans are `true`/`false`, numbers are right-aligned with tabular figures, and truncated values end with `…`.
- **Space** opens the cell inspector in the drawer: a jsonb tree, bytea hex, wrapped text. It follows the active cell as you move.
- **F4** opens the row referenced by a foreign key.

### Sort and find in results

- **Sort**: the ⇅ toggle on a column header — ascending → descending → the query's own order. The backend reorders its buffered rows (stable; numbers compare as numbers, everything else as text, which also orders ISO dates/timestamps; NULLs last either way) and the grid re-reads its window: no re-run. Blocked while edits are staged (they're keyed by row position). A capped result says only the loaded rows were sorted. Applying edits forgets the query order (the remembered rows would be stale).
- **Find** (Ctrl+F in the grid): searches every buffered cell's full value (case-insensitive) on the backend, up to 5,000 matches; they're highlighted, the current one outlined and focused; Enter / F3 next, Shift+Enter previous, Esc closes. A single selected cell's value pre-fills it.

### Quick chart
- **Chart** in the results header (Ctrl+Shift+G) opens a bar or line chart beside the grid; the grid stays as the chart's table view.
- **Defaults** come from the column types: a date/timestamp column becomes a time-axis **line**. Otherwise the first text column becomes **bars** of categories. Every number column becomes a series, up to four.
- **Pickers:** X (any column), Y (toggle chips, number columns only, ≤ 4), and Line/Bar. The choice belongs to the tab and is carried over to the next result by column name, so re-running with other parameters keeps the chart.
- **Data:** the backend sends just the chosen columns of the buffered rows in one request (`/api/results/{id}/columns`, values cut to 200 chars), not windows of everything. Rows sharing an x are summed, null x is left out, and categories keep the query's order (its ORDER BY is the point) up to 60 bars. Time and numbers are sorted. A footer says when any of that happened or the result was capped.
- **Look**, following the dataviz method:
  - Four categorical slots in fixed order (blue, orange, aqua, yellow), validated for CVD and normal-vision separation against both panel surfaces. The light-mode aqua and yellow are under 3:1 contrast; the grid next to the chart is the required table view.
  - Marks: 2px lines, bars ≤ 24px with a 4px rounded data end and a square baseline, 2px gaps between grouped bars, hairline solid gridlines, and round 1/2/5 ticks with compact labels (1.3K).
  - Time ticks fall on calendar boundaries (days step by date, so DST doesn't shift them; weeks start on Monday).
  - A legend appears only for two or more series. Hover shows a crosshair with ringed dots (line) or a band highlight (bar), plus a tooltip with every series.
- Hand-written SVG, no chart library: the result is small, and the marks have to follow the spec above anyway.

## 6. Editing

- **What's editable** comes from the row description (table OID + attnum per column): a column is editable when its table's full primary key is in the result; computed columns never are. Adding/deleting rows needs a single-table result. Read-only cells say why (tooltip/message), up front.
- **Keys:** F2, Enter, double-click or just typing starts editing (the editor gets the full value, not the grid's 500-char window). Enter commits and moves down, Tab moves right, Shift+Enter is a newline, Esc cancels. Ctrl+D sets NULL (on a whole selection too), Delete marks/unmarks rows, Alt+Insert adds a row (editing starts on the first non-key column), Ctrl+Z undoes the last staged change.
- **Staged, not live:** edited cells are amber (tooltip: old value), deleted rows struck through, new rows marked `+` with untouched columns shown as `default`. The header pill reads `3 changes · Review · Discard · Apply`.
- **Review** (Ctrl+S) opens the drawer's Edits view with the exact SQL Apply runs.
- **Apply** runs on the tab's own session as one unit: `BEGIN … COMMIT`, or — if you already have a transaction open in that tab — a savepoint, so the edits join your transaction instead of committing it behind your back.
  - Every statement must affect exactly one row. UPDATEs also check the old values (`… AND col IS NOT DISTINCT FROM 'old'`; text comparison for `json` and other types without equality), so a row changed by someone else fails the batch.
  - Any failure (conflict, invalid value, constraint) rolls back everything, keeps the staged edits and highlights the offending row; Postgres' own message is shown.
  - New values are sent as quoted literals, so Postgres parses them with each column's own input rules (`'yes'` for bool) and rejects invalid ones.
  - `RETURNING *` writes what was actually stored (defaults, triggers, normalisation) back into the buffer; the grid repaints without a blank flash.
- Re-running the query or closing the tab with staged edits asks Apply / Discard / Cancel.

- **Paste** (Ctrl+V of Excel / LibreOffice / TSV text): the block lands at the selection's top-left as staged edits — existing cells updated (with their old values as originals), rows past the end become new rows; one value pasted into a bigger selection fills it; a first row repeating the column names is skipped; columns past the last are reported, not wrapped. Empty fields are NULL (the copy side writes NULL as empty too). Quoted fields keep tabs and line breaks. One Ctrl+Z undoes the whole paste. Read from the paste event's clipboard data, so no clipboard permission is needed.

### Find a value everywhere

- Right-click a cell (or the inspector's search button) → **Find … everywhere**: which tables of the connection hold this value. Columns are picked by type family (uuid → uuid columns, numbers → number columns, text → text columns, dates/timestamps/inet likewise; domains by their base type); integers only in key-like columns — primary/unique/foreign keys, indexed, or named id / *_id — or every quantity column would match 3.
- The UI gets the plan (tables × candidate columns) and then searches table by table, two at a time (the catalog pool's size), smallest first, so progress shows and Stop works. Each table is one read-only query ORing its columns with the value cast to each column's own type (indexes apply), counting up to 100+ rows per column, with a 5 s timeout; timeouts are listed as "not searched". Table and column names from the client are checked against the catalog before they're quoted into SQL.
- Results group by table → column with row counts; clicking one opens `SELECT * … WHERE col = value` in a new tab.

### Relations: enums and foreign keys

- **Per result column** (Navigation/RelationReader, cached with the buffer): its source column (from the row description, so aliases and joins don't matter), enum labels (by type OID — computed `'x'::plan` columns too), the single-column foreign key it holds, and the single-column keys pointing at it. Composite keys are skipped: following one column of them would be wrong. Each referenced table gets a label column — a well-known name (name, title, code, email…), NOT NULL ones first, else its first text column — so keys read as `77 · user77@example.com`.
- **Value picker** under the cell editor for enum and FK columns: type to filter (value or label; exact, then prefix, then contains), ↑/↓, Enter/Tab or click takes it. Referenced tables of up to 100 rows are listed whole; bigger ones are searched server-side (`key = q` or label `ILIKE %q%`, read-only, 3 s timeout).
- **Right-click a column** (single-column selection): *Go to users where id = 42* — `IN (…)` for a multi-row selection, `IS NULL` for nulls — opens a new tab and runs it; the reverse direction is listed for each table referencing the column (*invoices where user_id = 42*). *Join users* appends the statement with the related table LEFT-joined under the original (nothing of yours is rewritten) and runs it. The join is spliced into the FROM clause only when that's provably safe — a plain SELECT naming the source table once, every column outside FROM qualified (`i.total`), no subqueries — since an unqualified `id` would turn ambiguous; otherwise it's `SELECT q.*, u.* FROM (…) q LEFT JOIN users u ON u.id = q.user_id`. Only offered for SELECT-like statements (a DML … RETURNING can't be a subquery).
- **Filter / Exclude** (right-click, any column): the selected value goes into the WHERE of the statement the result came from — `col = v`, `IN (…)` for a multi-row selection, `IS NULL`, or `a = 1 AND b = 2` for several columns of one row. Exclude is NULL-safe (`IS DISTINCT FROM v`, `(col IS NULL OR col NOT IN (…))`), so excluding a value doesn't silently drop the NULL rows too. The condition is ANDed onto an existing WHERE (a top-level OR gets parenthesized first) or becomes a new WHERE before GROUP BY/ORDER BY/LIMIT, through the source table's alias since WHERE can't see output aliases. Computed columns, set operations and a table named twice are wrapped (`SELECT * FROM (…) q WHERE q.col …`). The statement is replaced in place when the editor still holds it as it ran (one undo step each, so filters stack and Ctrl+Z peels one off), else the filtered version is appended; then it runs.
- **Inspector** (Space) shows the same for the focused cell — enum values with the current one marked, the referenced row's label with Go to / Join, and who references the value — on read-only sessions too, where the editor's picker never appears.
- Appending to the editor adds the missing `;` to the last statement first, so an appended statement never joins the one before it.

## 7. Export

- `Copy | ▾` split button in the results header; the same menu on right-click in the grid; **Ctrl+Shift+C** opens the export dialog.
- **One click** per format with the last-used options: TSV, CSV, JSON, Markdown, **INSERT** (one per row or multi-row `VALUES`; plain / `ON CONFLICT DO NOTHING` / upsert on the PK), **UPDATE by key**, `IN (…)` list, WHERE clause. INSERT/UPDATE whose table can't be inferred open the dialog instead of failing.
- **Scope:** a range selection exports exactly that; a single cell (or none) means the whole result. IN/WHERE use the selected column's values.
- **Table and column names** come from the row description (table OID + attnum per column, even through aliases), resolved once per result over a separate connection. Selecting only `users` columns from a join still gives `INSERT INTO public.users`.
- **Dialog:** format list, options, a live 20-row preview, Copy / Save to file (named after the table).
- Generated on the backend. Values are written as literals Postgres accepts for the column type (verified by round-tripping every type in the seed data, arrays with NULLs, 2-D arrays, intervals with months, NaN). A value cut by the buffer's safety limit is **refused**, never exported as if complete.
- Later: **whole table → file** bypassing the grid and the cap via `COPY … TO STDOUT`.

## 8. Catalog and autocomplete

- **Catalog pool:** a small (2-connection), server-enforced read-only pool per connection, separate from tab sessions — schema browsing and source lookups never run inside or wait behind a tab's transaction.
- **Sidebar:** a connection switcher on top (it goes to that connection's open tab, or opens one; also New / Edit / Delete), then the schema tree for the **active tab's** connection. With no tab open it lists connections.
- **Tree:** schemas → Tables / Views / Materialized views / Foreign tables / Functions / Procedures / Sequences / Enums → table columns (PK key icon, FK link icon, type; default/FK target/comment in the tooltip) plus Indexes and Constraints. Noise is filtered: system schemas, extension-owned functions, sequences owned by serial/identity columns, PG 18's NOT NULL constraints.
  - All objects load in one query (instant expand and filter); columns/indexes/constraints load when a table is expanded.
  - A flat virtual list with 24px rows, not CDK Tree. Filter box at the top; keyboard: arrows, → expand, ← collapse/parent, Enter.
  - A database with a single user schema opens with it and its tables expanded.
- **Actions:** double-click / Enter on a table or view opens a data tab (`SELECT * … ORDER BY <pk> LIMIT 1000`, run immediately); on a function its `CREATE OR REPLACE` definition. Right-click: Open data, New query with SELECT (columns listed), Show definition, Copy name, Refresh.
- The tree refreshes itself after DDL run from yadbc (CREATE / ALTER / DROP / …).
- **Autocomplete**, fed by the same catalog cache (no extra round trips once the tree has loaded):
  - A forgiving lexer over the statement under the cursor (not a parser, so half-typed SQL works) finds the relations in FROM / JOIN / UPDATE / INTO with their aliases — also when FROM comes after the cursor (`select | from users u`).
  - After FROM/JOIN/UPDATE/INTO: tables, views and schemas (`public` objects unqualified, others schema-qualified); after `schema.`: that schema's objects; after `alias.` or `table.`: its columns.
  - Elsewhere: columns of every relation in the statement (a name present in several is inserted qualified, `u.id`), the aliases, keywords (in the case you're typing), common functions and your own functions. Tables too when nothing is in scope yet.
  - Nothing inside strings or comments. Monaco's word-based suggestions are off.

## 9. EXPLAIN

- **Ctrl+E** — EXPLAIN (plan only, nothing runs). **Ctrl+Shift+E** (or Shift+click the Explain button) — `EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON)`.
- ANALYZE executes the statement, so it **always** runs inside a transaction that's rolled back (a savepoint when the tab has one open) — for every statement, since `SELECT purge()` writes too. Sequence increments and external side effects can't be undone; the plan says "ran in a rolled-back transaction". Read-only prod sessions still refuse writes.
- Runs on the tab's session (its `SET`s apply), cancellable like a query; an error inside EXPLAIN points at the right spot in the editor.
- **Visual plan in the results area** (not the drawer — a plan diagram needs width):
  - Top-down tree of node cards: title (`Index Scan using users_pkey on users u`, `Gather (2 workers)`, `Update on users`), key condition, **own** time and share (heat badge + bar), rows actual vs estimated, loops. Edges get thicker with the rows flowing through them.
  - Own time = per-loop time × loops ÷ processes (parallel nodes report per-process averages) minus children; without ANALYZE, shares come from estimated cost.
  - Summary: execution / planning / JIT time, slowest node, worst misestimate, cache hit ratio; copy the plan JSON (e.g. for explain.dalibo.com).
  - Warnings: estimates off ≥10× (not for scans a Limit or Merge Join stopped early), filters discarding most rows on a seq scan, sorts/hashes spilling to disk, nested loops whose inner side runs thousands of times, index-only scans hitting the heap.
  - Detail pane for the selected node (starts on the slowest): times, rows, buffers, cost and every raw property. Drag the background to pan.

### Index suggestions

- **Next to every plan** ("N index suggestions · up to −X% cost" in the plan header, an Indexes tab beside Node) and **for the recorded workload** (activity tab → Index advisor; MCP `suggest_indexes`). Insert puts a ready `CREATE INDEX CONCURRENTLY …` into the editor (or a new tab); nothing is ever created by the advisor.
- **Analysis** (Advisor/PlanAnalyzer): re-plans the statement with `EXPLAIN (VERBOSE)` on the read-only catalog session (VERBOSE prints every column as alias.column, so conditions are matched against the scanned table's real columns rather than guessed from SQL). Candidates come from Seq Scans that keep a small share of a big table (equality / range conditions of top-level ANDs — not under an OR, not inside a function call), Seq Scans repeated as a Nested Loop's inner side, index scans that filter again, and a Sort (under a Limit) directly over a scan. Column order: equality columns (most distinct values first, from pg_stats), then one range column, else the ORDER BY columns (DESC only when directions are mixed — a uniform order is a backward scan). Skipped when an existing valid btree already starts with those columns; then a note says the planner chose the scan anyway (too many matching rows, or stale statistics).
- **Proof with HypoPG** when the extension is installed: each candidate is created hypothetically in that backend only (works in a read-only session), the statement re-planned, and the cost before/after, whether the planner uses it, and the estimated size reported. Candidates the planner ignores are listed as "tried". `hypopg_reset()` always runs before the pooled session goes back. Without HypoPG the suggestions are marked unverified and the UI says how to enable it.
- **Workload**: the 40 costliest DML statements of this database in `pg_stat_statements` (catalog/tool queries filtered out). Their `$1` placeholders can't go through EXPLAIN on Npgsql's extended protocol (a literal `$1` is a bind parameter there — and the failed bind breaks the connection), so each is `PREPARE`d and planned with `plan_cache_mode = force_generic_plan` via `EXPLAIN EXECUTE p(NULL, …)` — PG 12+. `interval $2` (normalized from a typed literal) is rewritten to `$2::interval`. Candidates are merged across statements (one on (a) folds into one on (a, b)), proven per statement, and ranked by time saved ≈ Σ total_exec_time × cost reduction. Also listed: tables read mostly by sequential scans, and never-scanned non-unique indexes (with the caveat that replicas keep their own counts).

### Schema diagram

- **Visualize schema** (schema row's right-click menu, the diagram button by Schema/History, or the palette) opens a diagram tab — one per connection, schema switchable in place — filling the central plane like the activity tab.
- **Data** (Catalog/DiagramReader): the schema's tables and columns, primary keys, and every foreign key touching them, composite ones included. Tables of other schemas at either end of such a key come along as external nodes (dashed, keys only).
- **Layout** — systematic, not force-directed: ELK's layered (Sugiyama) algorithm, lazy-loaded (`elkjs`, ~1.4 MB chunk only when a diagram opens). References flow left → right, so lookups (countries, currencies) sit left of the tables that point at them; crossings are minimized layer by layer and nodes balanced (Brandes–Köpf); edges are routed orthogonally between the exact rows via fixed ports — the key column on the referenced table's right edge, the FK column on the referencing table's left edge — and drawn with rounded corners, a crow's foot at the "many" end and a bar at the "one" end, dashed when the FK is nullable. Tables with no relation go to an alphabetical grid underneath instead of scattering the graph.
- **Cards**: name, estimated rows, columns with key / link icons and types (nullable columns get a hollow dot). Long tables show their key columns plus the first others up to 14 rows and "+ N more"; **Keys only** shows just the key columns (and re-lays out).
- **Export** (toolbar): Copy as PNG, Save PNG, Save SVG — the whole diagram in the current theme, with a caption (schema, counts, connection, date). The SVG is generated from the layout, not serialized from the screen: the on-screen cards are HTML, and an SVG carrying HTML (foreignObject) taints the canvas so it could never become a PNG. JetBrains Mono (latin + latin-ext) is embedded as data URIs, since an SVG rendered as an image can't reach the page's web fonts; text is cut to fit with measured widths (SVG has no ellipsis). PNG is 2×, scaled down for huge diagrams to stay under Chromium's canvas limits. Saving uses a normal browser download (WebView2 puts it in Downloads).
- **Interaction**: drag pans, the wheel zooms around the cursor, Fit; click a table to highlight its relations and related tables (the rest dims); find-a-table highlights matches and Enter centres the first; double-click runs `SELECT * … LIMIT 100` in a new tab.

## 9b. AI assistant

- In the drawer: **Ask AI** next to Explain and Run in the editor toolbar (writing a query is its main job), Ctrl+I, or "Ask AI" on an error card or a plan. Any OpenAI-compatible endpoint (for example a LiteLLM proxy) set in AI settings: endpoint and model in `ai.json`, the API key in Windows Credential Manager (`yadbc:app:llm-key`). Test lists the endpoint's models.
- Chat goes through the backend (the key never reaches the page) and streams back as server-sent events: content and a thinking model's `reasoning_content` separately — reasoning shows as "Thinking…", then folds away.
- **Context**, built per question: the statement under the cursor (or the selection), its tab's last error (message, SQLSTATE, detail, hint), its plan as compact one-line-per-node text (EXPLAIN JSON would eat a 16k context), and the schema in three tiers within ~24k characters: full detail (columns, types, PK, NOT NULL, FK targets, and every index the table has) for the tables the statement, its plan or the conversation is about and their FK neighbours both ways — the prompt tells the model to check those indexes rather than suggest ones that exist; column names for as many other tables as fit; bare names past that. Tables are matched the way people write them — exact, without underscores ("antiaffinities", "virtual machines"), singular, or by initials ("vms"). A small schema goes in whole. Extension-owned objects are left out. **Never result rows.** Each part shows as a chip and can be switched off.
- Quick actions follow the context: explain / fix an error, explain the plan, make it faster, explain the query, write a query.
- **Team settings:** an admin (the broker's `yadbc.admin` role) can share their endpoint, model and max tokens, with the API key or without. After signing in to the broker, anyone without an endpoint of their own uses the team's: with their own key if they set one, else the shared key.
  - The shared key is fetched once (audited on the broker) and cached in Credential Manager. A changed or keyless team setting drops the cached copy.
  - Your own endpoint overrides the team setting entirely.
  - The team setting refreshes with the sharing sync and disappears on sign-out.
- Answers render from a small Markdown parser into data (no HTML from the model). SQL blocks get Copy, Insert (under your SQL, selected) and Replace (in place of the statement asked about, if it's still there as it was). Nothing an answer contains runs by itself.

## 9c. Schema changes: compare, table definition, table editor

One model serves all three (`web/src/app/schema-model`):
- **The snapshot** (backend `SchemaChanges/SnapshotReader`, read over the read-only catalog pool) holds a schema's structure:
  - tables: columns with type, default, identity, generated and collation; constraints; indexes; triggers; partitioning;
  - views and materialized views, functions and procedures, enums, sequences.
- **Definitions** come from Postgres' own `pg_get_*def`, read with `SET LOCAL search_path = pg_catalog` inside a read-only transaction. Every name in them is then schema-qualified, so generated scripts run whatever the target session's search_path is, and `SET LOCAL` leaves the pooled connection as it was.
- **Left out:** extension-owned objects, partitions' cloned indexes and constraints, and identity columns' internal sequences.

**The diff** (`diff.ts`, pure and unit-tested) turns two snapshots into one Change per object: create, drop or alter.
- **Phased statements:** each change carries statements tagged by phase, and the script is the selected changes' statements in phase order: schemas, enums, sequences, tables, columns, constraints, indexes, foreign keys, functions, views, triggers, then drops in reverse.
- **Changed in place where Postgres can:** column type (`USING col::type`), default, NOT NULL, identity, enum values (ADD VALUE in the right position), sequence options, and views that only gain columns (CREATE OR REPLACE).
- **Dropped and re-created:** other view changes, materialized views, changed indexes, constraints and triggers, functions whose return type changed, and generated expressions.
- **Renames:** an index or trigger with the same definition under another name is a rename.
- **Notes instead of SQL** for what Postgres can't do (removing or reordering enum values, partitioning changes).
- **Drops** are flagged destructive and never selected by default.
- **Verified** by a round trip against real Postgres: drift a cloned database, apply the script, re-compare to zero.

**Compare schemas** is a tab (Ctrl+K, or the connection menu) between two connections, optionally limited to some schemas.
- **Direction:** the script makes the target look like the source. The tab wears the target's environment colour.
- **Layout:** the list groups differences by kind, with tables' columns, constraints and indexes under them. Filters: missing / different / extra, plus text. The side panel shows both definitions as a line diff and the change's statements.
- **Actions:** Copy, Open in new tab (on the target), and Apply.
- **Apply** (`/api/schema-changes/{id}/apply`) runs all statements in one transaction (all or nothing; the failing statement is named), is recorded in History as an edit, and re-compares. It's refused for prod: prod changes go through an editor tab, where the read-only lock applies like everywhere else.

**Table definition:** *Show definition* now works for tables too. Postgres has no `pg_get_tabledef`, so it's the same generator: serial sequences, CREATE TABLE with its constraints, indexes, foreign keys, triggers and comments.

**Table editor** (*Edit table…* on a table, *New table…* on a schema or in Ctrl+K) is a form, with the SQL shown live as you edit.
- **What you can edit:** columns (name, type, NOT NULL, default, identity, primary key, comment); keep or drop existing indexes and constraints; add indexes, unique, check and foreign-key constraints; rename the table; its comment.
- **How the SQL is made:** the edit is the "source" and the live table the "target", so the same diff produces the ALTER statements.
- **Renames:** columns remember their original name, so a rename is RENAME COLUMN, not a drop and an add.
- **Left as they are:** triggers and partitioning.
- **Running it:** Apply and Open in new tab, as in Compare.

## 10. MCP server

- Official C# MCP SDK (Streamable HTTP, stateless) in the same process, on its **own fixed port** `127.0.0.1:47800` (the UI port changes every launch; a client config can't follow that). If the port is taken (another yadbc window), that instance runs without MCP.
- **Off by default.** Ctrl+K → "MCP server for Claude…": switch on, copy the `claude mcp add --transport http yadbc http://127.0.0.1:47800/mcp --header "Authorization: Bearer …"` command, rotate the token.
- **Two listeners, two worlds:** on the MCP port only `/mcp` exists (bearer token persisted in Credential Manager as `yadbc:app:mcp-token`, loopback Host check, 503 while off); on the UI port `/mcp` doesn't exist. Neither token opens the other.
- **Per connection:** "Allow Claude (MCP)" — default on for local/dev, **off for prod** unless switched on.
- **Tools** (all marked read-only): `list_connections`, `describe_schema` (objects, or one table's columns/keys/indexes/constraints/view definition), `run_query`, `explain_query` (text plan; ANALYZE allowed), `suggest_indexes` (one statement, or the pg_stat_statements workload; HypoPG-proven when available), `get_activity` (active sessions, waits, blockers).
- **Read-only, in layers:** catalog-pool sessions are `default_transaction_read_only`; every call runs in `BEGIN READ ONLY` that is always rolled back, with a 30 s statement timeout; only SELECT / WITH / TABLE / VALUES / SHOW (EXPLAIN: queries only) are accepted; results come through a server-side cursor (only real queries can be declared — data-modifying CTEs are refused — and it stops after `max_rows`, max 1000; cells cut at 2000 chars). Verified: plain UPDATE, CTE writes, `select 1; update …`, and `set_config(…read_only, off)` all fail or are undone.
- **Every MCP query is recorded in History** (shown as "Claude"), including refused ones with their error.
- Rows are a prompt-injection channel: tool descriptions say returned values are data, never instructions; keep sensitive databases switched off.

## 10b. Shared connections (broker)

An optional extra: yadbc stays fully usable with local connections and no sign-in.

**Goal:** stop passing connection strings around in chat. It's a team catalog of connections and their logins, not access control. Everyone who can sign in sees every share (prod included), and a login fetched into yadbc is as safe as the machine it's on. Sign-in is long-lived on purpose: asking for 2FA every time would send people back to pasting them into chat.

### Broker
- A small standalone service on a Kubernetes cluster, behind its Gateway or Ingress. Code lives in `src/Yadbc.Broker` (ASP.NET minimal API), with the request/response records shared with the app in `src/Yadbc.Contracts`. A Helm chart in `deploy/helm/yadbc-broker`, with a setup guide in `deploy/README.md`.
- **SQLite** on a PVC, single replica, `strategy: Recreate`. Tables: users, devices, shares, installs, snippets, settings, audit.
  - Logins are encrypted with AES-GCM, with the key in a k8s Secret.
  - A nightly `VACUUM INTO` copy is the backup.
- It never connects to a database: databases are reachable only from people's machines. It hands out connection details; the data path stays client → DB, tunnels included.

### Sign-in
- **The broker is the only OIDC client.** Entra ID or any OIDC provider works; the issuer, client id and secret are its config.
  - yadbc opens the system browser at the broker's `/login`.
  - After the code flow, the broker redirects to yadbc's local backend with a one-time code.
  - yadbc exchanges that code (PKCE) for a **broker token**.
- **Broker token:** opaque and stored hashed. It lasts 90 days, extended by every use, and can be revoked per device (`/me/devices`). Kept in Credential Manager as `yadbc:app:broker-token`.
- **Why not the provider's own tokens:** this needs one app registration with a fixed redirect URL (yadbc's port changes every launch), and token lifetimes don't depend on the provider.
- **Admins** can edit or delete any share. Admin is an app role: Entra's `roles` claim, with the claim name and value configurable for other providers.

### Shares
- **Contents:** the connection profile without anything specific to one machine:
  - name, host, port, database, env;
  - tunnel kind, SSH host alias, kube namespace/target;
  - MCP limit: allowed or never, never by default for prod.
- **Login:** either **included** (username + password, write-only on the broker) or **bring your own** (the share is a template).
- **Per-person overrides, kept locally:** SSH user, kube context, kubeconfig path, own login for templates, MCP off.
- **Ownership:** anyone signed in can share. The person who shares is the owner and can add co-owners.
- **Edits:** saved with a version check (If-Match). A conflict says "changed by Petr 2 min ago — reload".
- **Audit:** share changes and every login fetch (who, when). Owners and admins can see it.

### Catalog and install
- Shared connections are a **catalog**, not a second list.
  - *Shared connections…* (in the connection menu and Ctrl+K) lists every share with search, env, owner, included/own login, and how many people installed it.
  - **Install** adds a share to your connections, into the group chosen in the catalog's *Install into* (remembered). It sits in the one list next to local connections, with a shared mark (owner's initials).
- **Sharing converts:** sharing a local connection uploads it, and your entry becomes the installed link. There's one copy, and your edits reach everyone. Owners edit through the usual connection dialog. *Stop sharing* turns it back into a local connection for the owner.
- **Uninstall** removes it from your list only.
- **Deleted shares:** a share deleted on the broker stays in the lists of people who installed it, marked *no longer shared*. They get *Keep as local* (copies the cached login into Credential Manager) or *Remove*.
- **Templates:** opening a template share for the first time asks for your login, which is stored locally under the share.

### Sync and logins
- **Sync:** installed shares sync on start, on window focus and every 5 min (ETag). The catalog loads when you open it. Installed shares are cached in `shared.json`, so the list works offline.
- **Logins:** fetched at connect time and cached in Credential Manager under the installed connection's own entry (`yadbc:<connection id>`, like any local password, so *Keep as local* needs nothing more), so prod still opens when the broker is down. If a cached login fails authentication (SQLSTATE 28P01), yadbc fetches it again and retries once. That's how a password rotation reaches everyone.
- **Sign-out** removes the broker token and the cached shared logins. Installed shares stay in the list and ask for sign-in.
- **In the app:** an installed share is an ordinary profile with a `shared` link (share id, version, login mode, MCP ceiling, owners, can-edit, orphaned). Sync overwrites the shared fields and keeps the per-person ones. In the connection dialog the fields that come from the share are locked for non-owners. Owners' edits go to the broker with If-Match, and a conflict says who changed it and when. A share that switches to "own login" drops everyone's cached shared password. The sign-in callback (`/sharing/callback`) is the one UI-port path without the per-launch token: the system browser doesn't have it, so the state remembered at sign-in proves it's our own round trip.

### Shared snippets
- **Where they go:** a snippet on a shared connection travels with the share, so everyone who installed it gets it. A snippet for every connection goes to the whole team. One on a connection only you have can't be shared: share the connection first, or offer it on every connection.
- **Sharing moves it:** like a connection, sharing uploads your snippet and your copy becomes the shared one. *Stop sharing* turns it back into yours.
- **Who changes it:** its author, the share's owners and admins (rename or move, stop sharing, delete for everyone). Everyone else can *Copy to my snippets*.
- **Saving:** last save wins, with no version check: it's one short text.
- **Sync:** the list comes with the sharing sync (ETag) and is cached in `shared-snippets.json`, so it works offline. Deleting a share deletes its snippets.
- **Audit:** sharing, changing and deleting are audited, in the share's trail when the snippet is on a share.

### Team settings
- One row per setting in the broker's `settings` table. Today there's one: the AI assistant (§9b).
- Read by anyone signed in, changed by admins only. The key is write-only like a share login: encrypted with AES-GCM bound to `team:ai`, and every fetch audited.

### API
- `GET /shares` (the catalog)
- `GET/PUT/DELETE /shares/{id}`
- `PUT /shares/{id}/login` (write-only)
- `GET /shares/{id}/login`
- `GET /shares/{id}/audit`
- `PUT/DELETE /me/installs/{id}`
- `GET /me`
- `GET/DELETE /me/devices`
- `GET /login`, `GET /auth/callback`, `POST /token`
- `GET/PUT/DELETE /team/ai`, `GET /team/ai/key`
- `GET /snippets`, `PUT/DELETE /snippets/{id}`

### Later
- Limiting a share to provider groups, if "everyone sees everything" ever becomes a problem.

## 11. UI

Overrides of the debate verdict: **desktop window from day one** (so the shortcut map below uses the normal Ctrl keys), and **light prod safety instead of the step-by-step escalation**.

### Session restore

- Open tabs survive a restart or crash: editor tabs with their unsaved SQL, cursor and scroll; activity and diagram tabs (with the schema); the active tab. Layout and option preferences (sidebar width, editor height, drawer width/pin, last export options) go with them.
- Kept in `workspace.json` in the data folder (next to `connections.json`), written atomically by the backend — not localStorage: the desktop window runs on a random port per launch, so the page's origin, and every origin-scoped store with it, changes each start (the old localStorage prefs silently reset because of that).
- Saved 800 ms after any change (typing, cursor, tabs opened/closed/switched, schema, prefs) and flushed with a keepalive request when the window goes away; nothing is saved until the previous state has been applied, so an early save can't wipe it.
- Restored editor tabs connect lazily — when first shown — so a start doesn't open every session (prod ones, tunnels) at once; the active tab connects right away. Tabs of connections deleted since are dropped. A writable-again (unlocked) prod tab comes back locked: the lock is per session.

### Updates

- An installed yadbc (Velopack, per user: the Windows installer or the Linux AppImage) checks the GitHub releases a minute after start and then every 4 hours, and downloads a new version in the background.
- Nothing restarts on its own. When the download is done, the status bar shows **Restart to update**.
  - Clicking it saves the workspace and closes the window the normal way (window position, sessions, tunnels); Velopack swaps the files in and starts yadbc again with the tabs back. A running query or staged edits get a confirmation first.
  - Not clicking it: the update is installed when yadbc quits, without starting it again. If yadbc was killed instead, it's installed at the next start.
- `dotnet run` and other non-installed runs never update. `YADBC_UPDATE_SOURCE` (a folder or URL with a Velopack feed) replaces GitHub, for testing.
- The app finds its UI next to the exe, so starting it from any folder (a taskbar pin, a terminal) works.

### Layout
```
┌ sidebar ─────┬ tabs ··· [IN TX 00:42 · Commit · Rollback] [Run] ┬ drawer ┐
│ ● conn ▾  🔒 │ Monaco editor                                    │ (over- │
│ Schema·Hist· │──────────── splitter (dbl-click = maximize) ─────│  lay,  │
│ Saved        │ 1,284 rows · 24 ms  [1][2] Messages  pill CopyAs │  pin   │
│ tree…        │ grid                                             │  to    │
│              │                                                  │  push) │
├──────────────┴──────────────────────────────────────────────────┴────────┤
│ status: env · role* · search_path* · tx · READ ONLY · edits │ Σ selection │
└──────────────────────────────────────────────────────────────────────────┘
```
- **Sidebar:** connection switcher on top, then a Schema · History · Saved segmented control, and a tree that follows the active tab. Ctrl+B collapses it.
- **Tabs:** editor, data and activity tabs share one strip. A tab is bound to a connection and shows its env colour.
- **Results header** (fixed 30px): counts and timing (query/fetch split in a tooltip), one chip per result set, a Messages chip, the edits pill and Copy as…. Right-clicking a chip pins it.
- **Status bar** (22px): the session's real state as reported by Postgres. Values that are at their default are muted; anything unusual stands out (role differs, non-default `search_path`, open or failed transaction, read-only). The tx state comes from ReadyForQuery; a background probe after each batch, never blocking results, refreshes role, `search_path` and read-only.
- **Drawer** (right, 440px, overlays the content by default, can be pinned so it pushes the layout): one view at a time, Cell · Explain · Edits · (later AI). Esc closes it.
- **Activity and locks:** its own tab type (Ctrl+Shift+A, the pulse button by Schema/History, or the connection menu), one per connection, sharing the tab strip. The editor stays mounted, hidden, while it shows, because it owns every tab's Monaco model.
  - Polls every 2 s over the catalog pool (read-only, never a tab session), only while the tab is visible and not paused, and never with two requests in flight. A failed poll keeps the last snapshot and shows the error.
  - **Sessions** are drawn as a blocked-by tree: a waiter sits under its first blocker, from `pg_blocking_pids` (called only for sessions waiting on a lock, since it takes lock-manager locks). The biggest pile-up comes first and blockers get a "blocks N" badge, so the head of a lock queue is the first row. Filters: this database only, hide idle (a session others wait on is never hidden), and text search. The time column is what matters for the state: query age when active, transaction age when idle in transaction, idle time otherwise. It turns amber after 1 min and red after 10. yadbc's own tabs are labelled.
  - **Locks:** this database's locks, waits first, with wait time (`waitstart`, PG 14+, read via jsonb so older servers still work). Granted (virtual) transaction-id locks are left out because every transaction holds one. Click a lock to jump to its session.
  - **Cancel** (`pg_cancel_backend`) is one click; **terminate** (`pg_terminate_backend`) asks first and says the open transaction rolls back (and that it's prod, or yadbc's own tab). Buttons only appear where this login may signal: its own role, `pg_signal_backend` for non-superusers, or superuser. Both are recorded in History (kind `activity`) with whose session it was and its query.
- **Your tab is blocking others:** every 10 s (and right after a commit or rollback), one catalog query per connection with open tabs asks `pg_stat_activity` for sessions waiting on a lock whose `pg_blocking_pids` include one of our tabs' pids (`POST /api/activity/{conn}/blocked-by`). A tab that blocks someone gets a red count on its tab; the tab itself shows a banner — how old its transaction is, how many it blocks, the longest wait and who (user@application · query) — with **Rollback**, **Commit** and **Show** (the Activity tab). Another tab blocking shows in the status bar and jumps there on click. Rollback/Commit is a socket op (`end-tx`) on the tab's own session, so the results stay; it's refused while a query runs.

### Controls
- **A command registry is the core:** each command has an id, label, icon, shortcut, a `when` condition and a run function. The palette, context menus (CDK Menu), the few visible buttons and the tooltips all render from it, so there is no button-only or palette-only action. Tooltips show shortcuts (`Run · Ctrl+Enter`).
- **Command palette:**
  - **Ctrl+K** — every command available right now (its `when` holds), with its shortcut; fuzzy search.
  - **Ctrl+P** — go to: tables, views, functions and enums of the active connection, recent queries (searched server-side), connections. Enter opens the natural thing (data tab, definition, history inserted into the editor, switch connection); Alt+Enter opens a history entry in a new tab. `>` switches to commands.
  - Fuzzy ranking: a substring at a word start first, then initials (`ua` → users_audit), then mid-word substrings and scattered matches; unit-tested.
- **Light prod safety:**
  - Prod sessions start with `default_transaction_read_only = on`. The server enforces it, so even `SELECT purge()` can't write.
  - **One click on the lock** in the tab unlocks writes for that tab (open red lock, status bar `WRITES ENABLED`), until you relock or close it. No typing, no timers. Read-only survives reconnects.
  - The red frame and tab edge make prod obvious at a glance.
  - Everywhere: `UPDATE` / `DELETE` without `WHERE` asks for a single confirmation (Enter to proceed).
- **No Ctrl+Alt shortcuts.** On the Czech layout AltGr = Ctrl+Alt and types `@ { } [ ] \ | # & < > *`.

| Action | Shortcut |
|---|---|
| Command palette | Ctrl+K |
| Go to object / history / saved | Ctrl+P |
| Run statement / selection-or-all | Ctrl+Enter / Ctrl+Shift+Enter |
| Cancel | Esc Esc |
| Explain / Explain Analyze | Ctrl+E / Ctrl+Shift+E |
| New / close / next tab / tab N | Ctrl+T / Ctrl+W / Ctrl+Tab / Ctrl+1..9 |
| Toggle sidebar / results / drawer | Ctrl+B / Ctrl+J / Ctrl+Shift+B |
| Inspect cell / open FK target | Space / F4 |
| Copy (TSV) / Copy as… | Ctrl+C / Ctrl+Shift+C |
| Review edits (grid) / save query (editor) | Ctrl+S |
| Set NULL / add row / undo staged edit | Ctrl+D / Alt+Insert / Ctrl+Z |

### Looks
- **One density** (no density setting): 24px grid and tree rows, 32px tab strip, 30px results header, 22px status bar, 4px spacing scale.
- **Type:** 13px system UI font (Segoe UI Variable); one self-hosted mono font (JetBrains Mono or Geist Mono) shared by Monaco and the grid; tabular figures everywhere.
- **Colour:**
  - Zinc neutrals for almost everything, and one indigo accent used only for focus and selection.
  - Red is reserved for prod. Errors use red-orange plus an icon plus words.
  - Amber means pending or warning. Dev amber appears only in the window chrome; staged-edit amber appears only inside the data area.
- **Tokens:** about 25 semantic CSS variables mapped into the Tailwind theme, so classes say `bg-raised`, never `bg-zinc-900`. Light and dark are two palettes over one structure, with 1px hairlines in both. A token test checks WCAG AA contrast for the env and staged colours.
- **Shape and motion:** radius 4px on controls and 8px on overlays. Shadows only on overlays. No blur or glass. 120–150 ms ease-out on overlays only, nothing animated in the grid, and `prefers-reduced-motion` respected.
- **Icons:** Lucide as inline SVG through one `<y-icon>` component, 16px at 1.5px stroke.
- **Monaco:** one instance with a model plus view state per tab, lazy-loaded, `automaticLayout: false` with one ResizeObserver. Its theme is generated from the same tokens.

## 12. Later (not v1)

- AI in the drawer (any OpenAI-compatible endpoint)
- Shared connections broker and catalog (§10b)
- Other engines (SQL Server first), then extract the engine interface
- A Kubernetes Secret as a credential source, libpg_query-based classification, diffing a history entry against the editor

## 13. Open questions

- JetBrains Mono vs Geist Mono.

Resolved: the WHERE-less `UPDATE`/`DELETE` confirmation stays; the desktop host is **Photino.NET** (cross-platform, WebView2 on Windows).
