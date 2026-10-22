# yadbc UI/UX debate verdict

## Rulings

### Controls

| Decision | Why | Won by |
|---|---|---|
| **A command registry comes first.** Each command has an id, label, icon, shortcut, a `when` check (`tab.running`, `grid.hasSelection`, `conn.readOnly`…) and a run function. The Ctrl+K palette, CDK Menu context menus, the few visible buttons and the tooltips all render from it. No action is reachable only from the palette or only from right-click. | One source of truth means no drift between button, menu and shortcut, features can be found, and the MCP surface comes almost free. The `when` checks double as safety guards. | All four (Engineer's spec, DBA's rule) |
| **One Run/Cancel button at the right end of the 32px tab strip.** It reads `Run`, and while running `Cancel · 3.2s · Esc Esc`. If the backend is still alive after 5s, it offers a separate `Terminate backend` step. | Run and Cancel never happen at the same time. The mouse path stays visible at zero extra height. | Engineer, Minimalist; DBA for the terminate step |
| **Cancel is sent out of band**, through Npgsql's CancellationToken (protocol CancelRequest). Terminate opens a second connection to call `pg_terminate_backend(pid)`. If terminate is refused for lack of rights, the UI says why. | The running session is blocked and can't take a second statement. | DBA, correcting Engineer |
| **Run semantics.** Ctrl+Enter runs the statement under the cursor; Ctrl+Shift+Enter runs the selection, or everything if nothing is selected. A 2px gutter bar marks the range before it runs. Statement boundaries come from a splitter that understands strings, comments and `$$`, not from a full parser. | You see exactly what will run, and the splitter covers 99% of cases cheaply. | Unanimous |
| **Esc Esc (within 400ms) cancels.** A single Esc only closes the topmost overlay, menu or cell edit. | One key with two jobs would cancel a 4-minute query whenever Jan closes the inspector. | Power User, DBA, Minimalist |
| **Transactions.** Auto/Manual is a per-connection setting, also available as a palette command, and red defaults to Manual. While a transaction is open, `IN TX 00:42 · Commit · Rollback` appears in the tab strip to the left of Run, and the status bar shows the matching pill. Neither exists while idle. Closing the tab or switching its connection with an open transaction always blocks with Commit / Rollback / Cancel. | The buttons are visible when they matter and absent when they don't. Being stuck "idle in transaction" is the real killer. | Power User (visibility), Minimalist (only while live), DBA (placement) |
| **No client-side auto-rollback.** Red sessions get `SET idle_in_transaction_session_timeout = '10min'` on the server. The timer turns amber at 60s and red-orange at 5min. | An unwatched rollback is as dangerous as an unwatched write. The server enforces the timeout even if the UI crashes. | Power User, Minimalist over DBA |
| **Prod safety ladder.** <br>**Green and amber:** no prompts, ever. <br>**Red, locked:** session `default_transaction_read_only = on`, so Postgres rejects writes with 25006. <br>**Red, unlocking:** click the lock glyph or use the palette, type the connection name, and the tab stays writable for 10 minutes before relocking (also relocks on tab close). <br>**Red, unlocked:** every run happens inside an implicit transaction, so you have to commit. Typed table-name confirmation only for TRUNCATE, DROP or ALTER as the first keyword, or UPDATE/DELETE with no WHERE token. | Friction is rare and proportional. The server is the real guarantee and the lexical check is a convenience, which also covers `SELECT purge()`. | DBA (server read-only, ladder), Minimalist (timed unlock), Engineer (no parser) |
| **EXPLAIN.** Ctrl+E runs a plan-only EXPLAIN. Ctrl+Shift+E runs EXPLAIN ANALYZE; anything other than a plain SELECT runs inside `BEGIN … ROLLBACK`, and the drawer header says "Executed inside rolled-back transaction". | EXPLAIN ANALYZE of a DELETE actually deletes. | DBA |
| **Grid editing.** F2, double-click or typing starts an edit; Tab or Enter commits the cell. Ctrl+D sets NULL. Alt+Insert adds a row; Delete marks rows for deletion. Ctrl+Z undoes the last staged edit. Results without a PK never enter edit mode, and the tooltip says why. Prod is editable only while the tab is unlocked. | Blocking up front beats refusing after 40 staged edits. Making prod "impossible" would push Jan to hand-write UPDATEs, which is worse. | Engineer (no-PK), Power User (prod unlockable) |
| **Apply.** Ctrl+S, or Review on the edits pill, opens the drawer with the generated SQL in read-only Monaco. Apply runs everything in one transaction, and any statement affecting a row count other than 1 rolls back the whole batch and highlights the offending statement. | Concurrent deletes and fake PKs fail loudly instead of partially applying. | DBA (invariant), all |
| **Re-running over staged edits** blocks with Apply / Discard / Cancel. This only happens when edits exist. | Carrying edits across a re-run is clever but ambiguous when the shape of the result changes. | Power User, Engineer over Minimalist |
| **Copy/Export.** Ctrl+C copies TSV. `Copy as…` appears as a split ghost button in the result header (the main part copies TSV), in the grid context menu and in the palette: CSV, JSON, Markdown, INSERT, UPDATE by PK, `IN (…)`, WHERE, Save to file…. Generation happens server-side and files stream from `/results/{id}/export`. When the result is capped, the button says so. "Re-run uncapped → file" is offered only for statements classified as read-only, runs under `BEGIN READ ONLY`, and names the statement it will run again. | Export as INSERT is the reason the app exists, so it gets one click. A re-run must not repeat a write. | Engineer (server stream), Power User (cap honesty, IN/WHERE), DBA (re-run guard) |
| **Tooltips** appear after 400ms and print the shortcut from the registry, e.g. "Run · Ctrl+Enter". | They teach the keyboard to a mouse user without onboarding. | Engineer |

**Shortcut rules: no Ctrl+Alt at all** (AltGr on the Czech layout is Ctrl+Alt and types `@ { } [ ] \ | # & < > *`), and no browser-reserved keys (Ctrl+W/T/N/Tab, Ctrl+PgUp/PgDn, Ctrl+Shift+J/I/C).

| Action | Shortcut |
|---|---|
| Command palette | Ctrl+K (Monaco's Ctrl+K chords unbound) |
| Go to object / saved / history | Ctrl+P |
| Run statement / run selection or all | Ctrl+Enter / Ctrl+Shift+Enter |
| Cancel | Esc Esc |
| Explain / Explain Analyze | Ctrl+E / Ctrl+Shift+E |
| Toggle sidebar / results pane / drawer | Ctrl+B / Ctrl+J / Ctrl+Shift+B |
| Inspect cell | Space |
| Open referenced FK row | F4 |
| Review staged edits (grid) / save query (editor) | Ctrl+S |
| Copy as… mini-palette (grid) | Alt+C |
| New / close / switch / cycle tabs | Alt+N / Alt+W / Alt+1..9 / Alt+PgUp, Alt+PgDn |

Monaco's Ctrl+H stays find-replace, so history lives in the sidebar and in Ctrl+P (see Layout), not on Ctrl+H. Before locking the map, verify Ctrl+J, Ctrl+Shift+B and Alt+C in both Chrome and Edge.

### Layout

| Decision | Why | Won by |
|---|---|---|
| **Shell.** A 32px tab strip, then the editor, a 4px splitter, the results, and a 22px status bar. The sidebar is on the left and the drawer on the right. It is a single CSS grid driven by CSS variables, with custom 60-line pointer-capture gutters writing on rAF, and no resize library. Sizes persist in localStorage inside try/catch. | It is cheap and runs at 60fps. | Engineer |
| **Tabs.** Each tab is bound to exactly one connection. The env color shows as a 2px top edge plus a 6px dot, and prod tabs also show the lock. Editor tabs, data tabs and Activity tabs share one strip and differ by icon. A tab never silently switches connection. | This prevents pasting into the wrong tab. | DBA, all |
| **Status bar.** 22px, app-level, cannot be collapsed, and reflects the active tab's live session. **Left, fixed positions:** env chip (name/db) · role, *only when it differs from the configured user or is a superuser* · search_path, *only when it is not the default* · tx pill (`AUTOCOMMIT` muted / `IN TX 00:42` / `FAILED — ROLLBACK REQUIRED`) · `READ ONLY` or `WRITES UNLOCKED 08:12` · staged-edit count. **Right, truncates first:** selection aggregates (Count/Sum/Avg/Min/Max), computed by the backend over the buffer. The chip tooltip shows host:port, PID, PG version and search_path, and clicking copies them. | Wire truth always has a home. Being muted when default and loud when not answers the Minimalist's habituation point. | Power User, DBA, Engineer (format), Minimalist (calm default) |
| **How the bar stays true.** Tx state comes from ReadyForQuery (tracked in the session wrapper where Npgsql doesn't expose it). A background probe (`current_user, session_user, search_path, transaction_read_only, pg_backend_pid()`) runs after each run batch, *after* results have rendered. A probe failing with 25P02 means the transaction has failed. | This keeps the DBA's truth while avoiding the Engineer's latency cost, because the probe is never on the critical path. | Judge synthesis |
| **Sidebar.** The top row is a 32px connection switcher (dot, name, lock; opens the fuzzy picker). Below it is a 28px segmented control **Schema · History · Saved**, and below that the content. The schema tree shows the active tab's connection as a flattened 24px virtual list, not CDK Tree. Ctrl+B collapses it to 0. There is no 40px activity rail. | The rail would hold one icon. A segmented control gives History a mouse path without evicting the drawer and without a permanent column. | Minimalist and Engineer (no rail), Power User (History needs a mouse home) |
| **History.** Persisted in SQLite on the backend, per connection, with timestamp, role, duration, rows and outcome (ok / error / cancelled / committed / rolled back). It is searchable in the sidebar and in Ctrl+P. Enter opens an entry in the current tab; Alt+Enter opens it in a new tab. Statements run on red also go to an append-only JSONL audit log. | "What did I run, and where?" | Power User, DBA |
| **Results header.** One fixed 30px row. Left: `1,284 rows · 24 ms`, with the query/fetch split in a tooltip; when capped it shows `10,000 (capped) · Fetch all · Re-run uncapped` in amber. Middle: result chips `[1 · 1,284] [2 · UPDATE 3]`, shown only when there is more than one, plus an always-present `Messages` chip whose count badge turns amber on NOTICE/WARNING and red-orange on ERROR and which auto-selects on error. Right-clicking a chip pins it, so the next run adds a chip instead of replacing it. Far right: the edits pill (when edits exist) and `Copy as…`. | No second tab-strip component, multi-result sets are handled, and its height never moves the grid. | Engineer, Minimalist; DBA (Messages severity) |
| **Errors.** The error card shows SQLSTATE, message, DETAIL, HINT and CONTEXT, and clicking it jumps to the error position, where Monaco has a red squiggle. NOTICEs come from Npgsql's Notice event and are never shown as toasts. | The half of the error you need is DETAIL and HINT. | DBA |
| **Staged edits indicator.** An amber filled pill in the results header (`3 changes · Review · Discard · Apply`), amber tint plus a 2px left edge on edited cells (old value in the tooltip), struck-through rows with a red gutter for deletes, and the count in the status bar. No floating bar. | A floating bar covers the bottom rows and the horizontal scrollbar exactly while you are editing there. | Engineer over Minimalist |
| **Drawer.** Overlays by default at 440px, resizable to 70%, Esc closes it. Pinning switches it to push mode, which relayouts once on `transitionend`. It shows one thing at a time via a segmented header: Cell · Explain · Edits · (later AI). The cell inspector follows the active cell live in both modes, with a jsonb tree, bytea hex and wrapped long text. | The grid stays stable for quick looks, pinning covers side-by-side work, and walking down 20 rows is the core loop. | Engineer, Minimalist; Power User (live follow) |
| **Data tabs.** Opening a table creates an SQL tab whose model is `SELECT * FROM t WHERE … ORDER BY … LIMIT …` with the editor collapsed to about 3 lines. There is no count(*); the size is shown as `~300M est.` from reltuples, and ORDER BY defaults to the PK only when it is indexed. | Filtering uses the same Monaco with its real completion, and "Show SQL" is free. | Engineer (mechanism), Power User (concept), DBA (prod-safe defaults) |
| **Monaco.** One instance with a model plus saved view state per tab. Lazy-loaded, `automaticLayout: false`, one ResizeObserver calling `layout()` once per rAF. | Twenty instances means hundreds of MB, and automaticLayout thrashes during drags. | Engineer |
| **Maximize.** Double-clicking the splitter maximizes results; Ctrl+J toggles the results pane. | Nobody should spend the day dragging a divider. | Power User, Minimalist |
| **Activity/Locks** is a full tab type: 2s refresh (pausable), a blocked-by tree, and cancel/terminate per row behind a confirm that names the PID and the query. It never opens in the sidebar or the drawer. | During an incident you watch it for minutes. | DBA (unanimous after rebuttals) |

### Looks

| Decision | Why | Won by |
|---|---|---|
| **Density.** One fixed density with no toggle. Grid rows 24px, tree rows 24px, tab strip 32px, results header 30px, status bar 22px, 8px horizontal cell padding, 4px spacing scale. | 24px is the median of the four proposals, and a toggle multiplies the grid geometry QA. | Engineer |
| **Fonts.** 13px system UI font (Segoe UI Variable / `system-ui`). One self-hosted mono font, JetBrains Mono or Geist Mono, as a woff2 subset with `font-display: block` and a preload, at 12.5–13px, shared by Monaco and the grid. `tabular-nums` everywhere numbers appear. | Grid column widths are measured in the mono font's metrics, so a late font swap would make every width wrong. | Engineer |
| **Column header.** Two lines at a fixed height: the column name, then the type in 10px mono (`int4`, `timestamptz`, `jsonb`) with PK/FK/NOT NULL glyphs. | It saves a trip to the schema tree, and the fixed height leaves the geometry alone. | Power User |
| **Values never lie.** NULL is a dim italic `null` in a muted token. The empty string is a faint `''`; ∅ is rejected because it reads as null. Leading and trailing whitespace show as visible dots. Booleans are the text `true`/`false`, so a copy matches what you see. Timestamps include their offset, numbers are right-aligned, and truncated values end in `…` with Space to open the inspector. Rows get a ≤2% parity stripe. The selected range gets an indigo fill plus a 1px border; the active cell gets a 2px ring. | Mixing up NULL and '' causes bad UPDATEs. | DBA, Power User |
| **Color.** Zinc neutrals carry about 95% of the UI. One indigo accent, used only for focus and selection. The saturated prod red is reserved for the env signal. Errors and FAILED tx use a distinct red-orange plus an icon plus words. Amber means pending or caution: staged edits, warnings, the dev env. | If color means one thing every time, the prod warning still registers. | All |
| **Prod cue.** Red connections get a 2px red inset frame around the editor and results, on top of the tab edge and dot. No hatching, no window-wide band, no pulse that runs forever. | Peripheral vision catches the frame while you type in Monaco. | DBA, trimmed by Minimalist |
| **Tokens.** About 25 semantic CSS variables (`--bg`, `--bg-raised`, `--fg`, `--fg-muted`, `--border`, `--accent`, `--conn-local/dev/prod`, `--edit-staged`, `--danger`…) mapped into the Tailwind theme, so classes read `bg-raised`, never `bg-zinc-900`. Dark mode is designed as its own palette (near-black `#0B0B0C`, light theme warm `#FAFAF9`), but both themes keep 1px hairlines; the structure is shared and only the token values differ. A token test checks WCAG AA for the env colors and staged amber in both themes. | One structure, two palettes, so components aren't reviewed twice. | Engineer over Minimalist on hairlines |
| **Shape.** Radius 4px on controls and 8px on overlays. Shadows only on overlays (menus, palette, drawer). No backdrop blur or glass anywhere above the grid or Monaco. | Blur over a scrolling grid forces recompositing on every frame. | Engineer, Minimalist |
| **Motion.** 120–150ms ease-out using transform/opacity, on overlays only. Nothing animates in the grid, and there is no shimmer or indeterminate bar. The running state is the elapsed counter inside the Run/Cancel button, shown after 300ms. `prefers-reduced-motion` is honored. | Any animation that delays seeing data is a tax on every query. | Engineer, Power User |
| **Icons.** Lucide as inline SVG through a `<y-icon>` component backed by a static map of about 40 icons, 16px at 1.5px stroke, `currentColor`. | Small bundle, crisp at small sizes. | Engineer |
| **The grid is a hand-written imperative renderer** outside Angular change detection: a recycled row and cell pool, precomputed column offsets, and on scroll it writes only textContent and transform. All chrome around it has a fixed height. Signals feed only the header, the pill and the status bar. | Speed is the product. | Engineer (no one opposed) |

## Where the strawman changes

1. **No toolbar stays, but no action is buried.** The registry drives the Ctrl+K palette, context menus and tooltips, and one Run/Cancel button sits in the tab strip.
2. **A 22px status bar is added** for wire-truthful session state, muted when default and loud when not, with selection aggregates on the right.
3. **The connection list is gone from the sidebar.** It becomes a switcher row, then Schema · History · Saved, then a tree that follows the active tab.
4. **The result header is restructured.** It becomes a fixed 30px row: rows and time (with the capped state), result chips, the Messages chip, the edits pill and `Copy as…`. `fetch 6 ms` moves into a tooltip, and the separate Copy/Export buttons merge into one split button.
5. **The pending badge becomes an amber pill** plus cell tint, gutter marks and a status bar count. Re-run and tab close are blocked while edits exist.
6. **A transaction model is added:** Auto/Manual per connection, Commit/Rollback appearing only while a transaction is open, close and switch blocked, and a server-side idle timeout on red.
7. **Prod becomes a ladder** instead of a binary lock: server read-only, then a typed 10-minute per-tab unlock, then implicit transactions, then typed confirmation for destructive statements, plus the red inset frame.
8. **The drawer is specified:** overlay with a pin-to-push toggle, one content at a time, live-following inspector. History lives in the sidebar, not the drawer.
9. **Maximize is added:** double-click the splitter, or Ctrl+J.
10. **Tables open as data tabs**, which are SQL tabs with the editor collapsed.
11. **Activity/Locks** gets its own tab type.

## Hard disagreements

| Issue | Side A | Side B | Call |
|---|---|---|---|
| Where session truth lives | Minimalist: a capsule in the tab strip that expands only on non-default state. | Power User and Engineer: a bottom status bar. DBA: the splitter doubles as the status strip. | **A bottom 22px bar, using the Minimalist's "calm unless non-default" rendering.** The splitter strip moves whenever you resize, so the eye can't learn where it is. A capsule overflows a tab strip that already holds tabs, Run and Commit/Rollback. |
| Abandoned transactions on prod | DBA and Engineer: client auto-rollback after 60s idle. | Power User and Minimalist: server-side `idle_in_transaction_session_timeout`. | **Server-side, 10 minutes, with timer color escalation.** A countdown pushes you to commit before you've checked anything. |
| Staged-edits surface | Minimalist: a floating bottom-center bar. | Engineer: a pill in the fixed header. | **The pill, amber-filled.** A floating bar covers the rows you're editing. |
| Re-run with staged edits | Minimalist: edits are PK-keyed, so carry them over. | Power User and Engineer: block. | **Block.** Pinning a result chip gives you the "keep both" case. |
| Activity rail | Power User: a 40px rail. | Minimalist and Engineer: none. | **No rail. Use a segmented control at the top of the sidebar.** |
| Post-statement probe | DBA: SHOW after every statement. | Engineer: only after SET or RESET, because of latency. | **Probe after every batch, in the background, after render.** Truth without latency. |
| Dark mode structure | Minimalist: elevation instead of borders. | Engineer: hairlines in both themes. | **Hairlines in both.** One structure to review. |
| Copy-as shortcut | Minimalist: Ctrl+Shift+C. | Power User: Ctrl+Alt+C. | **Neither.** Ctrl+Shift+C is DevTools and Ctrl+Alt is AltGr. **Alt+C**, scoped to the grid. |
| Amber collision (raised by the judge) | Dev env is amber. | Staged edits are amber. | **Keep both, kept apart by place.** The env amber only appears in chrome (edges, dots, chip) and never inside the data surface. Staged amber only appears inside cells and the pill. The token test must show the two are distinguishable. |

## Best lines of the debate

- **Power User:** "Your 28px rows cost six grid rows. My status bar costs one."
- **Power User:** "A rollback nobody watched is a write nobody watched."
- **Minimalist:** "Truth that never changes visually doesn't get read."
- **Minimalist:** "Confirmation dialogs teach people to click OK without reading."
- **DBA:** "The tab shows what you configured. The status bar shows what's true on the wire."
- **DBA:** "`SELECT purge_old_rows()` starts with SELECT."
- **Engineer:** "Rollback on the same chord as typing `{` is a real hazard."
- **Engineer:** "'Monaco-lite' doesn't exist."

## Deferred

- **Not v1:**
  - Tab strip merged into the window title row: Photino phase only, needs a frameless window.
  - Visual EXPLAIN graph: v1 shows the text and tree plan in the drawer.
  - AI in the drawer, the MCP server and the connection sharing broker. The registry is already shaped for MCP.
  - Count Distinct in the selection aggregates.
  - EXPLAIN-based row estimate before streaming an uncapped export from amber or red.
  - A real parser (libpg_query) for risk classification. The lexical check plus server-side read-only is enough for now.
  - Opening a history entry as a diff against the current editor.
  - Saved queries beyond a flat list.
- **Rejected outright:** density presets, ever; Monaco-lite filter inputs; an action toolbar strip; client-side auto-rollback; animated push drawer; glass or blur effects.