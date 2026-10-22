import {
  computed,
  DestroyRef,
  effect,
  inject,
  Injectable,
  signal,
  untracked,
  WritableSignal,
} from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { Subject } from 'rxjs'
import { Connections } from '../connections/connections'
import { Column, ConnectionProfile, RunError, ServerEvent, SessionInfo, Statement } from '../core/protocol'
import { QuerySocket } from '../core/query-socket'
import { Catalog } from '../schema/catalog'
import { PlanResult } from '../explain/plan-view'
import type { SavedTab } from '../core/session'
import { findParams, ParamValue } from '../core/params'
import type { ChartSpec } from '../chart/chart'

export interface ResultView {
  resultId: string
  index: number
  columns: Column[]
  rowCount: number
  done: boolean
  totalRows?: number
  capped?: boolean
  queryMs?: number
  fetchMs?: number
  /** Bumped when the backend buffer changes in place (applied edits). */
  version?: number
}

export interface CommandView {
  index: number
  tag: string
  elapsedMs: number
}

export interface NoticeView {
  severity: string
  message: string
}

export interface RunSummary {
  ok: boolean
  cancelled: boolean
  elapsedMs: number
}

export type TabStatus = 'connecting' | 'ready' | 'running' | 'failed'

/** One editor tab, bound to exactly one connection for its whole life. */
export class EditorTab {
  readonly kind = 'editor'
  readonly status = signal<TabStatus>('connecting')
  readonly openError = signal<string | null>(null)
  readonly session = signal<SessionInfo | null>(null)
  readonly results = signal<ResultView[]>([])
  readonly commands = signal<CommandView[]>([])
  readonly notices = signal<NoticeView[]>([])
  readonly activeResult = signal(0)
  readonly error = signal<RunError | null>(null)
  readonly runStartedAt = signal<number | null>(null)
  readonly lastRun = signal<RunSummary | null>(null)
  /** Result of the last EXPLAIN; shown instead of the grid until the next run. */
  readonly plan = signal<PlanResult | null>(null)
  /** Statements of the current run, to map error positions back to the editor. */
  lastStatements: Statement[] = []
  runId = ''
  initialSql = ''
  /** The editor's current text (kept in sync by the editor), for saving the workspace. */
  readonly text = signal('')
  /** Monaco cursor/scroll state, saved with the workspace and restored with the tab. */
  viewState: unknown = null
  /** Restored from the last session and not opened yet: connects when first activated. */
  lazy = false
  /** Data tabs run their SELECT as soon as the session is open. */
  autoRun = false
  /** The quick chart beside the grid: its columns, by the names they had (null: closed). */
  readonly chart = signal<{ spec: ChartSpec | null; columns: Column[] } | null>(null)
  /** Last values of the tab's `:name` parameters (saved with the workspace). */
  params: Record<string, ParamValue> = {}

  constructor(
    readonly id: string,
    readonly connection: ConnectionProfile,
    readonly title: string,
  ) {}
}

/** Live sessions and locks of a connection's server; polls over the catalog pool, no session of its own. */
export class ActivityTab {
  readonly kind = 'activity'

  constructor(
    readonly id: string,
    readonly connection: ConnectionProfile,
    readonly title: string,
  ) {}
}

/** A schema's tables and relations as a diagram; the schema can be switched in place. */
export class DiagramTab {
  readonly kind = 'diagram'
  readonly schema: WritableSignal<string>

  constructor(
    readonly id: string,
    readonly connection: ConnectionProfile,
    schema: string,
  ) {
    this.schema = signal(schema)
  }

  get title() {
    return `Diagram · ${this.schema()}`
  }
}

/**
 * Compare two connections' schemas. Its `connection` is the target — the one a script would change —
 * so the tab wears the target's environment colour.
 */
export class CompareTab {
  readonly kind = 'compare'
  readonly source: WritableSignal<ConnectionProfile>
  readonly target: WritableSignal<ConnectionProfile>
  /** null = every schema */
  readonly schemas = signal<string[] | null>(null)

  constructor(
    readonly id: string,
    source: ConnectionProfile,
    target: ConnectionProfile,
  ) {
    this.source = signal(source)
    this.target = signal(target)
  }

  get connection() {
    return this.target()
  }

  get title() {
    return `Compare · ${this.source().name} → ${this.target().name}`
  }
}

export type WorkTab = EditorTab | ActivityTab | DiagramTab | CompareTab

let tabSeq = 0
const DDL = /^\s*(create|alter|drop|truncate|comment|rename|grant|revoke|refresh)\b/i
let runSeq = 0

@Injectable({ providedIn: 'root' })
export class Workspace {
  private readonly socket = inject(QuerySocket)
  private readonly connections = inject(Connections)
  private readonly catalog = inject(Catalog)

  readonly tabs = signal<WorkTab[]>([])
  readonly activeTabId = signal<string | null>(null)
  /** The selected tab, whatever its kind. */
  readonly current = computed(() => this.tabs().find((t) => t.id === this.activeTabId()) ?? null)
  /** The selected tab when it's an editor (what run, explain, edits and the palette act on). */
  readonly activeTab = computed(() => {
    const t = this.current()
    return t?.kind === 'editor' ? t : null
  })
  readonly editorTabs = computed(() => this.tabs().filter((t) => t.kind === 'editor'))
  /** Text to add to a tab's editor (history "insert"); the editor component applies it. */
  readonly inserts$ = new Subject<{ tabId: string; text: string }>()
  /** Replace a statement in a tab's editor if it's still there as it ran; `done` says whether it was. */
  readonly replaces$ = new Subject<{
    tabId: string
    offset: number
    expected: string
    text: string
    done: (ok: boolean) => void
  }>()

  /** Changes worth saving that no signal shows (cursor, scroll). */
  readonly touched$ = new Subject<void>()
  /** Bumped when the editor's cursor or selection moves (what "the statement under the cursor" is). */
  readonly cursor = signal(0)
  /** The statement under the editor's cursor (or the selection), set by the editor. */
  currentStatement: (() => Statement | null) | null = null

  constructor() {
    this.socket.events$.pipe(takeUntilDestroyed(inject(DestroyRef))).subscribe((e) => this.onEvent(e))
    // Restored tabs connect when first shown — not all at once on start (prod ones, tunnels…).
    effect(() => {
      const tab = this.activeTab()
      if (tab?.lazy)
        untracked(() => {
          tab.lazy = false
          this.socket.send({ op: 'open', tabId: tab.id, connectionId: tab.connection.id })
        })
    })
  }

  /** Reopens the tabs of the last session; tabs of connections deleted since are dropped. */
  restore(saved: SavedTab[], active: number, profiles: ConnectionProfile[]) {
    const byId = new Map(profiles.map((p) => [p.id, p]))
    const tabs: WorkTab[] = []
    for (const s of saved) {
      const c = byId.get(s.connectionId)
      if (!c) continue
      if (s.kind === 'editor') {
        const n = tabs.filter((t) => t.kind === 'editor' && t.connection.id === c.id).length + 1
        const tab = new EditorTab(`t${++tabSeq}`, c, n > 1 ? `${c.name} (${n})` : c.name)
        tab.initialSql = s.sql
        tab.text.set(s.sql)
        tab.viewState = s.viewState ?? null
        tab.params = s.params ?? {}
        tab.lazy = true
        tabs.push(tab)
      } else if (s.kind === 'compare') {
        const source = byId.get(s.sourceId)
        if (!source) continue
        const tab = new CompareTab(`t${++tabSeq}`, source, c)
        tab.schemas.set(s.schemas ?? null)
        tabs.push(tab)
      } else if (s.kind === 'activity') {
        tabs.push(new ActivityTab(`t${++tabSeq}`, c, `Activity · ${c.name}`))
      } else {
        tabs.push(new DiagramTab(`t${++tabSeq}`, c, s.schema))
      }
    }
    this.tabs.set(tabs)
    this.activeTabId.set((tabs[active] ?? tabs[0])?.id ?? null)
  }

  openTab(connection: ConnectionProfile, sql = '', options: { autoRun?: boolean } = {}) {
    const n = this.editorTabs().filter((t) => t.connection.id === connection.id).length + 1
    const tab = new EditorTab(
      `t${++tabSeq}`,
      connection,
      n > 1 ? `${connection.name} (${n})` : connection.name,
    )
    tab.initialSql = sql
    tab.text.set(sql)
    tab.autoRun = !!options.autoRun && !!sql.trim()
    this.tabs.update((tabs) => [...tabs, tab])
    this.activeTabId.set(tab.id)
    this.socket.send({ op: 'open', tabId: tab.id, connectionId: connection.id })
  }

  /** One activity tab per connection: focuses it when it's already open. */
  openActivity(connection: ConnectionProfile) {
    const existing = this.tabs().find((t) => t.kind === 'activity' && t.connection.id === connection.id)
    if (existing) return this.activeTabId.set(existing.id)
    const tab = new ActivityTab(`t${++tabSeq}`, connection, `Activity · ${connection.name}`)
    this.tabs.update((tabs) => [...tabs, tab])
    this.activeTabId.set(tab.id)
  }

  /** One diagram tab per connection: focuses it (showing this schema) when it's already open. */
  openDiagram(connection: ConnectionProfile, schema: string) {
    const existing = this.tabs().find(
      (t): t is DiagramTab => t.kind === 'diagram' && t.connection.id === connection.id,
    )
    if (existing) {
      existing.schema.set(schema)
      return this.activeTabId.set(existing.id)
    }
    const tab = new DiagramTab(`t${++tabSeq}`, connection, schema)
    this.tabs.update((tabs) => [...tabs, tab])
    this.activeTabId.set(tab.id)
  }

  /** Compare from `source` (the active connection) to the most recently used other one, or itself. */
  openCompare(source: ConnectionProfile, target?: ConnectionProfile) {
    const used = this.tabs()
      .map((t) => t.connection)
      .reverse()
    const other =
      target ??
      used.find((c) => c.id !== source.id) ??
      this.connections.list().find((c) => c.id !== source.id) ??
      source
    const tab = new CompareTab(`t${++tabSeq}`, source, other)
    this.tabs.update((tabs) => [...tabs, tab])
    this.activeTabId.set(tab.id)
  }

  closeTab(tab: WorkTab) {
    if (tab.kind === 'editor') this.socket.send({ op: 'close', tabId: tab.id })
    const tabs = this.tabs()
    const i = tabs.indexOf(tab)
    this.tabs.set(tabs.filter((t) => t !== tab))
    if (this.activeTabId() === tab.id)
      this.activeTabId.set(this.tabs()[Math.min(i, this.tabs().length - 1)]?.id ?? null)
  }

  cycleTab(delta: number) {
    const tabs = this.tabs()
    if (!tabs.length) return
    const i = tabs.findIndex((t) => t.id === this.activeTabId())
    this.activeTabId.set(tabs[(i + delta + tabs.length) % tabs.length].id)
  }

  reconnect(tab: EditorTab) {
    tab.status.set('connecting')
    tab.openError.set(null)
    this.socket.send({ op: 'open', tabId: tab.id, connectionId: tab.connection.id })
  }

  run(tab: EditorTab, statements: Statement[]) {
    if (!statements.length || tab.status() === 'running') return
    this.startRun(tab, statements)
    this.socket.send({ op: 'run', tabId: tab.id, runId: tab.runId, statements })
  }

  /** EXPLAIN (plan only) or EXPLAIN ANALYZE (executes, rolled back) of one statement. */
  explain(tab: EditorTab, statement: Statement, analyze: boolean) {
    if (tab.status() === 'running') return
    this.startRun(tab, [statement])
    this.socket.send({ op: 'explain', tabId: tab.id, runId: tab.runId, statement, analyze })
  }

  private startRun(tab: EditorTab, statements: Statement[]) {
    tab.runId = `r${++runSeq}`
    tab.lastStatements = statements
    tab.plan.set(null)
    tab.results.set([])
    tab.commands.set([])
    tab.notices.set([])
    tab.error.set(null)
    tab.activeResult.set(0)
    tab.status.set('running')
    tab.runStartedAt.set(performance.now())
  }

  /** Appends text to a tab's editor on its own lines and selects it — never replaces what's there. */
  insertIntoEditor(tab: EditorTab, text: string) {
    this.activeTabId.set(tab.id)
    this.inserts$.next({ tabId: tab.id, text })
  }

  /** Swaps the statement a result came from for a new version (filter), selecting it. False when edited since. */
  replaceInEditor(tab: EditorTab, offset: number, expected: string, text: string): Promise<boolean> {
    this.activeTabId.set(tab.id)
    return new Promise((done) => this.replaces$.next({ tabId: tab.id, offset, expected, text, done }))
  }

  /** The tab's lock: toggles server-enforced read-only for this session. */
  setReadOnly(tab: EditorTab, readOnly: boolean) {
    if (tab.status() !== 'ready') return
    this.socket.send({ op: 'set-readonly', tabId: tab.id, readOnly })
  }

  /** After edits are applied the buffer changed size; the grid re-reads its rows. */
  resultChanged(tab: EditorTab, resultId: string, rowCount: number) {
    tab.results.update((rs) =>
      rs.map((r) => (r.resultId === resultId ? { ...r, rowCount, version: (r.version ?? 0) + 1 } : r)),
    )
  }

  cancel(tab: EditorTab) {
    if (tab.status() === 'running') this.socket.send({ op: 'cancel', tabId: tab.id })
  }

  private tab(id: string) {
    return this.editorTabs().find((t) => t.id === id)
  }

  private onEvent(e: ServerEvent) {
    switch (e.ev) {
      case 'opened': {
        const tab = this.tab(e.tabId)
        if (!tab) return
        tab.session.set(e.info ?? null)
        tab.openError.set(e.ok ? null : (e.error ?? 'Could not connect'))
        tab.status.set(e.ok ? 'ready' : 'failed')
        if (e.ok && tab.autoRun) {
          tab.autoRun = false
          // With :parameters it waits for Run, which asks for their values.
          if (!findParams(tab.initialSql).length)
            this.run(tab, [{ sql: tab.initialSql.trim().replace(/;$/, ''), offset: 0 }])
        }
        return
      }
      case 'result': {
        const tab = this.tab(e.tabId)
        if (!tab || e.runId !== tab.runId) return
        tab.results.update((r) => [
          ...r,
          { resultId: e.resultId, index: e.index, columns: e.columns, rowCount: 0, done: false },
        ])
        return
      }
      case 'result-progress': {
        for (const tab of this.editorTabs()) {
          if (!tab.results().some((r) => r.resultId === e.resultId)) continue
          tab.results.update((rs) =>
            rs.map((r) =>
              r.resultId === e.resultId
                ? {
                    ...r,
                    rowCount: e.rowCount,
                    done: e.done,
                    totalRows: e.totalRows ?? r.totalRows,
                    capped: e.capped ?? r.capped,
                    queryMs: e.queryMs ?? r.queryMs,
                    fetchMs: e.fetchMs ?? r.fetchMs,
                  }
                : r,
            ),
          )
        }
        return
      }
      case 'command': {
        const tab = this.tab(e.tabId)
        if (!tab || e.runId !== tab.runId) return
        tab.commands.update((c) => [...c, { index: e.index, tag: e.tag, elapsedMs: e.elapsedMs }])
        return
      }
      case 'notice': {
        this.tab(e.tabId)?.notices.update((n) => [...n, { severity: e.severity, message: e.message }])
        return
      }
      case 'run-finished': {
        const tab = this.tab(e.tabId)
        if (!tab || e.runId !== tab.runId) return
        tab.error.set(e.error ?? null)
        tab.lastRun.set({ ok: e.ok, cancelled: e.cancelled, elapsedMs: e.elapsedMs })
        tab.runStartedAt.set(null)
        tab.status.set('ready')
        // DDL run from here changes what the schema tree should show.
        if (tab.lastStatements.some((s) => DDL.test(s.sql))) this.catalog.refresh(tab.connection.id)
        return
      }
      case 'plan': {
        const tab = this.tab(e.tabId)
        if (!tab || e.runId !== tab.runId) return
        tab.plan.set({ json: e.plan, analyze: e.analyze, rolledBack: e.rolledBack })
        return
      }
      case 'session': {
        this.tab(e.tabId)?.session.set(e.info)
        return
      }
      case 'socket-reset': {
        // Server-side sessions died with the old socket; reopen every tab.
        for (const tab of this.editorTabs()) if (!tab.lazy) this.reconnect(tab)
        return
      }
    }
  }

  /** Used by the sidebar after a profile edit, so open tabs keep showing the right name/env. */
  connectionsChanged() {
    this.connections.reload().subscribe()
  }
}
