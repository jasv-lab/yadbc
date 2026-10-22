import { Dialog } from '@angular/cdk/dialog'
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { interval, map } from 'rxjs'
import { ConnectionDialog } from './connections/connection-dialog'
import { CatalogDialog } from './sharing/catalog-dialog'
import { ShareDialog } from './sharing/share-dialog'
import { Sharing } from './sharing/sharing'
import { SchemaActions } from './schema/schema-actions'
import { Connections } from './connections/connections'
import { Commands } from './core/commands'
import { ConnectionProfile, Statement } from './core/protocol'
import { bindParams, paramNames, ParamValue } from './core/params'
import { ParamsData, ParamsDialog } from './workspace/params-dialog'
import { SnippetDialog, SnippetDialogData } from './snippets/snippet-dialog'
import { Snippet } from './snippets/snippets'
import { SqlEditor } from './editor/sql-editor'
import { CellInspector } from './inspector/cell-inspector'
import { Drawer } from './inspector/drawer'
import { Sidebar } from './sidebar/sidebar'
import { Palette } from './palette/palette'
import { McpDialog } from './mcp/mcp-dialog'
import { Edits } from './editing/edits'
import { ConfirmData, ConfirmDialog } from './ui/confirm-dialog'
import { concatMap, from, lastValueFrom, toArray } from 'rxjs'
import { Icon } from './ui/icon'
import { ResultsPanel } from './workspace/results-panel'
import { ActivityView } from './activity/activity-view'
import { DiagramView } from './diagram/diagram-view'
import { CompareView } from './compare/compare-view'
import { Catalog } from './schema/catalog'
import { Session } from './core/session'
import { BlockingWatch } from './blocking/blocking-watch'
import { EditorTab, WorkTab, Workspace } from './workspace/workspace'

const SIDEBAR_DEFAULT = 260
const SIDEBAR_MIN = 180

const ENV_DOT = { local: 'bg-env-local', dev: 'bg-env-dev', prod: 'bg-env-prod' } as const
const ENV_TEXT = { local: 'text-env-local', dev: 'text-env-dev', prod: 'text-env-prod' } as const
const ENV_EDGE = { local: 'border-t-env-local', dev: 'border-t-env-dev', prod: 'border-t-env-prod' } as const

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SqlEditor, ResultsPanel, Icon, Drawer, Sidebar, ActivityView, DiagramView, CompareView],
  // minmax(0,1fr): an implicit `auto` column would grow to the content's min width (grid + pinned drawer).
  host: { class: 'grid h-screen grid-cols-[minmax(0,1fr)] grid-rows-[1fr_22px] select-none' },
  templateUrl: './app.html',
})
export class App {
  protected readonly workspace = inject(Workspace)
  protected readonly connections = inject(Connections)
  /** Shared connections: signs in on demand, keeps installed shares in sync from app start. */
  private readonly sharing = inject(Sharing)
  private readonly schemaActions = inject(SchemaActions)
  protected readonly commands = inject(Commands)
  protected readonly inspector = inject(CellInspector)
  private readonly edits = inject(Edits)
  private readonly palette = inject(Palette)
  private readonly dialog = inject(Dialog)
  private readonly catalog = inject(Catalog)
  private readonly session = inject(Session)
  protected readonly blocking = inject(BlockingWatch)

  /** A tab other than the one shown is blocking others: say so in the status bar. */
  protected readonly blockingElsewhere = computed(() => {
    const map = this.blocking.byTab()
    for (const tab of this.workspace.editorTabs()) {
      const count = map.get(tab.id)?.blocked.length ?? 0
      if (count && tab.id !== this.workspace.activeTabId()) return { tab, count }
    }
    return null
  })

  protected readonly editor = viewChild(SqlEditor)
  protected readonly envDot = ENV_DOT
  protected readonly envEdge = ENV_EDGE
  protected readonly envText = ENV_TEXT

  protected readonly sidebarOpen = signal(true)
  protected readonly sidebarWidth = signal(SIDEBAR_DEFAULT)
  protected readonly editorHeight = signal(260)
  protected readonly resultsMaximized = signal(false)

  private readonly now = toSignal(interval(100).pipe(map(() => performance.now())), { initialValue: 0 })
  /** Elapsed counter inside the Run/Cancel button, shown after 300 ms so fast queries don't flicker. */
  protected readonly elapsed = computed(() => {
    const started = this.workspace.activeTab()?.runStartedAt()
    if (started == null) return null
    const ms = this.now() - started
    return ms < 300 ? null : `${(ms / 1000).toFixed(1)}s`
  })

  protected readonly active = this.workspace.activeTab
  protected readonly current = this.workspace.current
  protected readonly activity = computed(() => {
    const t = this.current()
    return t?.kind === 'activity' ? t : null
  })
  protected readonly diagram = computed(() => {
    const t = this.current()
    return t?.kind === 'diagram' ? t : null
  })
  protected readonly compare = computed(() => {
    const t = this.current()
    return t?.kind === 'compare' ? t : null
  })
  /**
   * The editor stays mounted while an activity tab is showing (it owns every tab's Monaco model), so it's
   * bound to the active editor tab, or any editor tab, and just hidden.
   */
  protected readonly editorTab = computed(() => this.active() ?? this.workspace.editorTabs()[0] ?? null)
  protected readonly isProd = computed(() => this.current()?.connection.env === 'prod')

  private lastEscape = 0

  constructor() {
    this.registerCommands()
    this.session.start()
    effect(() => {
      if (!this.session.loaded()) return
      untracked(() => {
        this.sidebarWidth.set(this.session.pref('sidebarWidth', SIDEBAR_DEFAULT))
        this.editorHeight.set(this.session.pref('editorHeight', 260))
      })
    })
    const onKey = (e: KeyboardEvent) => this.onKey(e)
    window.addEventListener('keydown', onKey, { capture: true })
    inject(DestroyRef).onDestroy(() => window.removeEventListener('keydown', onKey, { capture: true }))
  }

  private registerCommands() {
    const tab = () => this.workspace.activeTab()
    const any = () => this.workspace.current()
    const canRun = () => tab()?.status() === 'ready'
    this.commands.register(
      {
        id: 'run.statement',
        label: 'Run statement',
        shortcut: 'Ctrl+Enter',
        also: ['F5'],
        when: canRun,
        run: () => this.run('statement'),
      },
      {
        id: 'run.all',
        label: 'Run selection or script',
        shortcut: 'Ctrl+Shift+Enter',
        when: canRun,
        run: () => this.run('all'),
      },
      {
        id: 'explain.plan',
        label: 'Explain',
        shortcut: 'Ctrl+E',
        when: canRun,
        run: () => this.explain(false),
      },
      {
        id: 'explain.analyze',
        label: 'Explain analyze (runs it, rolled back)',
        shortcut: 'Ctrl+Shift+E',
        when: canRun,
        run: () => this.explain(true),
      },
      {
        id: 'run.cancel',
        label: 'Cancel',
        shortcut: 'Esc Esc',
        when: () => tab()?.status() === 'running',
        run: () => this.workspace.cancel(tab()!),
      },
      {
        id: 'tab.new',
        label: 'New tab',
        shortcut: 'Ctrl+T',
        when: () => !!any(),
        run: () => this.workspace.openTab(any()!.connection),
      },
      {
        id: 'tab.close',
        label: 'Close tab',
        shortcut: 'Ctrl+W',
        when: () => !!any(),
        run: () => this.closeTab(any()!),
      },
      {
        id: 'ai.open',
        label: 'Ask AI',
        shortcut: 'Ctrl+I',
        run: () => this.inspector.showAi(),
      },
      {
        id: 'diagram.open',
        label: 'Visualize schema',
        when: () => !!any(),
        run: () => this.visualize(),
      },
      {
        id: 'activity.open',
        label: 'Activity and locks',
        shortcut: 'Ctrl+Shift+A',
        when: () => !!any(),
        run: () => this.workspace.openActivity(any()!.connection),
      },
      { id: 'tab.next', label: 'Next tab', shortcut: 'Ctrl+Tab', run: () => this.workspace.cycleTab(1) },
      {
        id: 'tab.prev',
        label: 'Previous tab',
        shortcut: 'Ctrl+Shift+Tab',
        run: () => this.workspace.cycleTab(-1),
      },
      {
        id: 'view.sidebar',
        label: 'Toggle sidebar',
        shortcut: 'Ctrl+B',
        run: () => this.sidebarOpen.update((v) => !v),
      },
      {
        id: 'view.results',
        label: 'Maximize results',
        shortcut: 'Ctrl+J',
        run: () => this.resultsMaximized.update((v) => !v),
      },
      {
        id: 'view.drawer',
        label: 'Toggle drawer',
        shortcut: 'Ctrl+Shift+B',
        run: () => this.inspector.toggle(),
      },
      {
        id: 'cell.inspect',
        label: 'Inspect cell',
        shortcut: 'Space',
        local: true,
        run: () => this.inspector.show(),
      },
      { id: 'connection.new', label: 'New connection', run: () => this.editConnection() },
      { id: 'sharing.catalog', label: 'Shared connections…', run: () => this.openCatalog() },
      {
        id: 'table.new',
        label: 'New table…',
        when: () => !!any(),
        run: () => this.schemaActions.editTable(any()!.connection, 'public', null),
      },
      {
        id: 'compare.open',
        label: 'Compare schemas…',
        when: () => !!any() || this.connections.list().length > 1,
        run: () => {
          const from = any()?.connection ?? this.connections.list()[0]
          if (from) this.workspace.openCompare(from)
        },
      },
      {
        id: 'sharing.share',
        label: 'Share this connection…',
        when: () => !!any() && (!any()!.connection.shared || !!any()!.connection.shared?.canEdit),
        run: () => this.shareConnection(this.connections.get(any()!.connection.id) ?? any()!.connection),
      },
      {
        id: 'palette.commands',
        label: 'Show all commands',
        shortcut: 'Ctrl+K',
        run: () => this.palette.open({ initial: '>', openConnection: (c) => this.openConnection(c) }),
      },
      {
        id: 'palette.goto',
        label: 'Go to table, function or recent query',
        shortcut: 'Ctrl+P',
        run: () => this.palette.open({ initial: '', openConnection: (c) => this.openConnection(c) }),
      },
      {
        id: 'connection.edit',
        label: 'Edit current connection',
        when: () => !!any(),
        run: () => this.editConnection(any()!.connection),
      },
      {
        id: 'mcp.settings',
        label: 'MCP server for Claude…',
        run: () => this.dialog.open(McpDialog),
      },
      {
        id: 'snippet.save',
        label: 'Save statement as snippet…',
        when: () => !!tab(),
        run: () => this.saveSnippet(),
      },
      {
        id: 'session.lock',
        label: 'Toggle read-only (lock) for this tab',
        when: canRun,
        run: () => this.toggleLock(tab()!),
      },
    )
  }

  private onKey(e: KeyboardEvent) {
    // A reload would drop every tab and unsaved SQL: F5 runs instead (via its command), Ctrl+R does nothing.
    const reload = e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r')
    if (reload) e.preventDefault()
    // Esc Esc within 400 ms cancels; a single Esc stays free for closing menus, widgets and edits.
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      // A single Esc closes the topmost thing; it must not count toward Esc Esc (cancel).
      if (this.inspector.open() && !this.dialog.openDialogs.length && !this.isInMonacoWidget(e)) {
        this.inspector.close()
        this.lastEscape = 0
        return
      }
      const now = performance.now()
      if (now - this.lastEscape < 400) this.commands.execute('run.cancel')
      this.lastEscape = now
      return
    }
    if (this.dialog.openDialogs.length) return
    // Ctrl+1..9 jumps to a tab.
    if (e.ctrlKey && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
      const t = this.workspace.tabs()[Number(e.key) - 1]
      if (t) {
        e.preventDefault()
        this.workspace.activeTabId.set(t.id)
      }
      return
    }
    this.commands.handleKey(e)
  }

  /** Esc inside Monaco's find/suggest widgets or the grid's cell editor belongs to them. */
  private isInMonacoWidget(e: KeyboardEvent): boolean {
    return (
      e.target instanceof Element &&
      !!e.target.closest('.find-widget, .suggest-widget, .monaco-hover, .yg-editor')
    )
  }

  protected async run(mode: 'statement' | 'all') {
    const tab = this.workspace.activeTab()
    const editor = this.editor()
    if (!tab || !editor) return
    const collected = editor.collect(mode)
    if (!collected.length || !(await this.settleEdits(tab, 'Running the query replaces the results'))) return
    const statements = await this.bindParams(tab, collected, 'Run')
    if (statements) this.workspace.run(tab, statements)
  }

  protected async explain(analyze: boolean) {
    const tab = this.workspace.activeTab()
    const editor = this.editor()
    if (!tab || !editor) return
    const [collected] = editor.collect('statement')
    if (!collected || !(await this.settleEdits(tab, 'Explaining replaces the results'))) return
    const [statement] = (await this.bindParams(tab, [collected], analyze ? 'Analyze' : 'Explain')) ?? []
    if (statement) this.workspace.explain(tab, statement, analyze)
  }

  private saveSnippet() {
    const tab = this.workspace.activeTab()
    const [statement] = this.editor()?.collect('statement', false) ?? []
    if (!tab || !statement?.sql.trim()) return
    this.dialog.open<Snippet, SnippetDialogData>(SnippetDialog, {
      data: { sql: statement.sql.trim(), connection: tab.connection },
    })
  }

  /** `:name` parameters: asks for their values (remembered per tab) and binds them. Null on cancel. */
  private async bindParams(tab: EditorTab, statements: Statement[], action: string) {
    const names = paramNames(statements.map((s) => s.sql))
    if (!names.length) return statements
    const values = await lastValueFrom(
      this.dialog.open<Record<string, ParamValue>, ParamsData>(ParamsDialog, {
        data: { names, remembered: tab.params, action },
      }).closed,
    )
    if (!values) return null
    tab.params = { ...tab.params, ...values }
    this.workspace.touched$.next()
    return statements.map((s) => ({ ...s, sql: bindParams(s.sql, values) }))
  }

  /**
   * Staged edits would be lost by a re-run or close: ask Apply / Discard / Cancel.
   * Resolves true when it's fine to continue.
   */
  private async settleEdits(tab: EditorTab, why: string): Promise<boolean> {
    const pending = this.edits.pendingFor(tab)
    if (!pending.length) return true
    const n = pending.reduce((sum, s) => sum + s.count(), 0)
    const choice = await lastValueFrom(
      this.dialog.open<string, ConfirmData>(ConfirmDialog, {
        data: {
          title: `${n} staged ${n === 1 ? 'change' : 'changes'}`,
          message: `${why} and would drop them. Apply them first?`,
          actions: [
            { id: 'apply', label: 'Apply' },
            { id: 'discard', label: 'Discard' },
            { id: 'cancel', label: 'Cancel' },
          ],
        },
      }).closed,
      { defaultValue: undefined },
    )
    if (choice === 'discard') {
      this.edits.discardFor(tab)
      return true
    }
    if (choice !== 'apply') return false
    const results = tab.results().filter((r) => pending.some((s) => s.resultId === r.resultId))
    const outcomes = await lastValueFrom(
      from(results).pipe(
        concatMap((r) => this.edits.apply(tab, r)),
        toArray(),
      ),
    )
    const failed = outcomes.find((o) => !o.ok)
    this.edits.say(failed?.message ?? outcomes.at(-1)!.message, !!failed)
    return !failed
  }

  protected toggleLock(tab: EditorTab) {
    this.workspace.setReadOnly(tab, !tab.session()?.readOnly)
  }

  protected toggleRun() {
    this.commands.execute(this.workspace.activeTab()?.status() === 'running' ? 'run.cancel' : 'run.statement')
  }

  /** Switching connection goes to its open tab if there is one; Ctrl+T opens another. */
  protected openConnection(c: ConnectionProfile) {
    // A shared connection where everyone uses their own login: ask for it first.
    if (c.needsLogin) return this.editConnection(c, true)
    const existing = this.workspace.editorTabs().find((t) => t.connection.id === c.id)
    if (existing) this.workspace.activeTabId.set(existing.id)
    else this.workspace.openTab(c)
  }

  protected async closeTab(tab: WorkTab) {
    if (tab.kind !== 'editor') return this.workspace.closeTab(tab)
    if (!(await this.settleEdits(tab, 'Closing the tab discards its results'))) return
    this.edits.discardFor(tab)
    this.editor()?.dropTab(tab.id)
    this.workspace.closeTab(tab)
  }

  /** The diagram of the schema the tree has selected, else public, else the first one. */
  protected visualize() {
    const conn = this.workspace.current()?.connection
    if (!conn) return
    this.catalog.objects(conn.id).subscribe((o) => {
      const schema = o.schemas.includes('public') ? 'public' : o.schemas[0]
      if (schema) this.workspace.openDiagram(conn, schema)
    })
  }

  protected editConnection(existing?: ConnectionProfile, thenOpen = false) {
    const ref = this.dialog.open<ConnectionProfile>(ConnectionDialog, { data: existing ?? null })
    ref.closed.subscribe((saved) => {
      if (saved && (!existing || thenOpen)) this.workspace.openTab(saved)
    })
  }

  /** The catalog of shared connections (and the broker sign-in); "Open" on an installed one opens it. */
  protected openCatalog() {
    this.dialog.open<ConnectionProfile>(CatalogDialog).closed.subscribe((c) => c && this.openConnection(c))
  }

  /** Share a local connection, or change how it's shared; signing in to the broker comes first. */
  protected shareConnection(c: ConnectionProfile) {
    if (!this.sharing.status().signedIn) return this.openCatalog()
    this.dialog.open<ConnectionProfile>(ShareDialog, { data: c })
  }

  protected keepLocal(c: ConnectionProfile) {
    this.sharing.keepLocal(c.id).subscribe()
  }

  protected deleteConnection(c: ConnectionProfile) {
    const question = c.shared
      ? `Uninstall "${c.name}"? It stays shared: you can install it again from Shared connections.`
      : `Delete connection "${c.name}"? Its saved password is removed too.`
    if (confirm(question)) this.connections.remove(c.id).subscribe()
  }

  protected revealError(offset: number) {
    this.editor()?.reveal(offset)
  }

  /** Drag the sidebar's edge; double-click puts it back. Capped so the editor keeps at least 400px. */
  protected startSidebarDrag(e: PointerEvent) {
    const bar = e.target as HTMLElement
    bar.setPointerCapture(e.pointerId)
    const startX = e.clientX
    const startW = this.sidebarWidth()
    let frame = 0
    let latest = startW
    const move = (ev: PointerEvent) => {
      const max = Math.max(SIDEBAR_MIN, window.innerWidth - 400)
      latest = Math.min(max, Math.max(SIDEBAR_MIN, startW + ev.clientX - startX))
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => this.sidebarWidth.set(latest))
    }
    const up = () => {
      bar.removeEventListener('pointermove', move)
      bar.removeEventListener('pointerup', up)
      // The last frame may not have run yet: apply and save the final value, not the last painted one.
      cancelAnimationFrame(frame)
      this.sidebarWidth.set(latest)
      this.session.setPref('sidebarWidth', latest)
    }
    bar.addEventListener('pointermove', move)
    bar.addEventListener('pointerup', up)
  }

  protected resetSidebar() {
    this.sidebarWidth.set(SIDEBAR_DEFAULT)
    this.session.setPref('sidebarWidth', SIDEBAR_DEFAULT)
  }

  protected startSplitDrag(e: PointerEvent) {
    const bar = e.target as HTMLElement
    bar.setPointerCapture(e.pointerId)
    const startY = e.clientY
    const startH = this.editorHeight()
    this.resultsMaximized.set(false)
    let frame = 0
    let latest = startH
    const move = (ev: PointerEvent) => {
      latest = Math.max(60, startH + ev.clientY - startY)
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => this.editorHeight.set(latest))
    }
    const up = () => {
      bar.removeEventListener('pointermove', move)
      bar.removeEventListener('pointerup', up)
      cancelAnimationFrame(frame)
      this.editorHeight.set(latest)
      this.session.setPref('editorHeight', latest)
    }
    bar.addEventListener('pointermove', move)
    bar.addEventListener('pointerup', up)
  }
}
