import { HttpClient } from '@angular/common/http'
import { inject, Injectable, signal } from '@angular/core'
import { filter, Observable } from 'rxjs'
import { QuerySocket } from '../core/query-socket'

export interface HistoryEntry {
  id: number
  connectionId: string
  connectionName: string
  sql: string
  startedAt: string
  durationMs: number
  rows: number | null
  outcome: 'ok' | 'error' | 'cancelled'
  error: string | null
  kind: 'run' | 'explain' | 'explain-analyze' | 'edit' | 'mcp' | 'activity'
}

/** Query history (backend SQLite). `changed` ticks after every run so an open list refreshes. */
@Injectable({ providedIn: 'root' })
export class History {
  private readonly http = inject(HttpClient)
  readonly changed = signal(0)

  constructor() {
    // History is written asynchronously on the backend; give it a moment before re-reading.
    inject(QuerySocket)
      .events$.pipe(filter((e) => e.ev === 'run-finished'))
      .subscribe(() => setTimeout(() => this.changed.update((v) => v + 1), 250))
  }

  list(
    connectionId: string | null,
    search: string,
    before?: number,
    limit = 100,
  ): Observable<HistoryEntry[]> {
    const params: Record<string, string> = { limit: String(limit) }
    if (connectionId) params['connectionId'] = connectionId
    if (search.trim()) params['q'] = search.trim()
    if (before) params['before'] = String(before)
    return this.http.get<HistoryEntry[]>('/api/history', { params })
  }

  remove(id: number): Observable<unknown> {
    return this.http.delete(`/api/history/${id}`)
  }
}
