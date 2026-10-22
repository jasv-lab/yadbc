import { HttpClient } from '@angular/common/http'
import { DestroyRef, inject, Injectable, signal } from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { catchError, exhaustMap, forkJoin, map, Observable, of, Subject, merge, timer } from 'rxjs'
import { QuerySocket } from '../core/query-socket'
import { EditorTab, Workspace } from '../workspace/workspace'

export interface BlockedSession {
  pid: number
  user: string | null
  application: string | null
  query: string | null
  waitSeconds: number
  blockedBy: number[]
}

export interface TabBlocking {
  /** Sessions waiting on a lock this tab's session holds. */
  blocked: BlockedSession[]
  /** How long the tab's transaction has been open (null: none). */
  xactSeconds: number | null
}

const INTERVAL = 10_000

/**
 * Notices when one of yadbc's own tabs holds locks other sessions are waiting for — the classic
 * forgotten open transaction. Every 10 s, per connection with open tabs, one cheap catalog query.
 */
@Injectable({ providedIn: 'root' })
export class BlockingWatch {
  private readonly http = inject(HttpClient)
  private readonly workspace = inject(Workspace)
  private readonly socket = inject(QuerySocket)
  private readonly now$ = new Subject<void>()

  /** tabId → what it blocks (only tabs that block someone, or have a transaction open). */
  readonly byTab = signal<ReadonlyMap<string, TabBlocking>>(new Map())

  constructor() {
    merge(timer(3000, INTERVAL), this.now$)
      .pipe(
        exhaustMap(() => this.poll()),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe((m) => this.byTab.set(m))
  }

  /** Re-check soon (after a rollback / commit). */
  refresh() {
    setTimeout(() => this.now$.next(), 400)
  }

  /** Ends the tab's transaction without touching its results. */
  endTransaction(tab: EditorTab, commit: boolean) {
    this.socket.send({ op: 'end-tx', tabId: tab.id, commit })
    this.refresh()
  }

  private poll(): Observable<ReadonlyMap<string, TabBlocking>> {
    const byConn = new Map<string, EditorTab[]>()
    for (const t of this.workspace.editorTabs()) {
      if (!t.session()) continue
      byConn.set(t.connection.id, [...(byConn.get(t.connection.id) ?? []), t])
    }
    if (!byConn.size) return of(new Map())
    const checks = [...byConn].map(([connId, tabs]) =>
      this.http
        .post<{ blocked: BlockedSession[]; ours: { pid: number; xactSeconds: number | null }[] }>(
          `/api/activity/${connId}/blocked-by`,
          { pids: tabs.map((t) => t.session()!.pid) },
        )
        .pipe(
          map((r) => ({ tabs, r })),
          catchError(() => of(null)),
        ),
    )
    return forkJoin(checks).pipe(
      map((results) => {
        const out = new Map<string, TabBlocking>()
        for (const x of results) {
          if (!x) continue
          for (const tab of x.tabs) {
            const pid = tab.session()!.pid
            const blocked = x.r.blocked.filter((b) => b.blockedBy.includes(pid))
            const xactSeconds = x.r.ours.find((o) => o.pid === pid)?.xactSeconds ?? null
            if (blocked.length || xactSeconds !== null) out.set(tab.id, { blocked, xactSeconds })
          }
        }
        return out
      }),
    )
  }
}

/** 45s · 3m 05s · 1h 02m */
export function age(seconds: number | null): string {
  if (seconds == null) return ''
  const s = Math.floor(seconds)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`
}
