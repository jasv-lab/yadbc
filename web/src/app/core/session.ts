import { HttpClient } from '@angular/common/http'
import { computed, inject, Injectable, signal } from '@angular/core'
import { toObservable } from '@angular/core/rxjs-interop'
import { catchError, debounceTime, filter, forkJoin, merge, of, Subject } from 'rxjs'
import { Connections } from '../connections/connections'
import { Workspace } from '../workspace/workspace'
import { ParamValue } from './params'
import { ConnectionProfile } from './protocol'
import { apiToken } from './token'

export type SavedTab =
  | {
      kind: 'editor'
      connectionId: string
      sql: string
      viewState?: unknown
      params?: Record<string, ParamValue>
    }
  | { kind: 'activity'; connectionId: string }
  | { kind: 'diagram'; connectionId: string; schema: string }

export interface SavedState {
  version: 1
  /** Index of the active tab. */
  active: number
  tabs: SavedTab[]
  /** Layout and option preferences (sidebar width, drawer, export options…). */
  prefs: Record<string, unknown>
}

const SAVE_DELAY = 800

/**
 * Open tabs (their SQL, cursor and scroll), the active tab and UI preferences, kept in the backend's
 * workspace.json so a restart or crash loses nothing. Saved shortly after every change; flushed when
 * the window goes away. Not localStorage: the desktop window's origin (random port) changes per launch.
 */
@Injectable({ providedIn: 'root' })
export class Session {
  private readonly http = inject(HttpClient)
  private readonly workspace = inject(Workspace)
  private readonly connections = inject(Connections)

  private prefs: Record<string, unknown> = {}
  private lastSaved = ''
  private readonly touched$ = new Subject<void>()
  /** True once the saved state is applied; nothing is saved before (it would overwrite it with nothing). */
  readonly loaded = signal(false)

  /** Everything whose change should be saved, read so the computed tracks it. */
  private readonly watched = computed(() => {
    this.workspace.activeTabId()
    for (const t of this.workspace.tabs()) {
      if (t.kind === 'editor') t.text()
      else if (t.kind === 'diagram') t.schema()
    }
    return {}
  })

  constructor() {
    merge(toObservable(this.watched), this.touched$, this.workspace.touched$)
      .pipe(
        filter(() => this.loaded()),
        debounceTime(SAVE_DELAY),
      )
      .subscribe(() => this.save())
  }

  /** Loads the saved state and restores the tabs (once the connections are known). */
  start() {
    forkJoin([
      this.http
        .get<Partial<SavedState>>('/api/workspace')
        .pipe(catchError(() => of<Partial<SavedState>>({}))),
      this.connections.reload().pipe(catchError(() => of<ConnectionProfile[]>([]))),
    ]).subscribe(([saved, profiles]) => {
      this.prefs = saved.prefs ?? {}
      if (saved.version === 1 && saved.tabs && !this.workspace.tabs().length)
        this.workspace.restore(saved.tabs, saved.active ?? 0, profiles)
      this.lastSaved = JSON.stringify(this.snapshot())
      this.loaded.set(true)
    })
    // Closing the window: the debounce may not have fired yet. keepalive lets the request outlive the page.
    addEventListener('pagehide', () => this.save(true))
  }

  pref<T>(key: string, fallback: T): T {
    return key in this.prefs ? (this.prefs[key] as T) : fallback
  }

  setPref(key: string, value: unknown) {
    this.prefs[key] = value
    this.touched$.next()
  }

  private snapshot(): SavedState {
    const tabs = this.workspace.tabs()
    return {
      version: 1,
      active: Math.max(
        0,
        tabs.findIndex((t) => t.id === this.workspace.activeTabId()),
      ),
      tabs: tabs.map((t): SavedTab => {
        if (t.kind === 'editor')
          return {
            kind: 'editor',
            connectionId: t.connection.id,
            sql: t.text(),
            viewState: t.viewState ?? undefined,
            params: Object.keys(t.params).length ? t.params : undefined,
          }
        if (t.kind === 'diagram')
          return { kind: 'diagram', connectionId: t.connection.id, schema: t.schema() }
        return { kind: 'activity', connectionId: t.connection.id }
      }),
      prefs: this.prefs,
    }
  }

  private save(keepalive = false) {
    if (!this.loaded()) return
    const body = JSON.stringify(this.snapshot())
    if (body === this.lastSaved) return
    this.lastSaved = body
    if (keepalive) {
      // keepalive bodies are capped at 64 KB; a bigger workspace relies on the debounced save before it.
      fetch('/api/workspace', {
        method: 'PUT',
        keepalive: body.length < 60_000,
        headers: { 'Content-Type': 'application/json', 'X-Yadbc-Token': apiToken },
        body,
      }).catch(() => undefined)
      return
    }
    this.http
      .put('/api/workspace', body, { headers: { 'Content-Type': 'application/json' } })
      .subscribe({ error: () => (this.lastSaved = '') })
  }
}
