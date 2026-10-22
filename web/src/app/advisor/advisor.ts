import { HttpClient } from '@angular/common/http'
import { inject, Injectable } from '@angular/core'
import { Observable } from 'rxjs'

export interface HypoStatus {
  /** CREATE EXTENSION hypopg done in this database: suggestions are proven by re-planning. */
  installed: boolean
  /** The package is on the server, so CREATE EXTENSION would work. */
  available: boolean
}

export interface QueryImpact {
  queryId: number | null
  query: string
  calls: number
  totalMs: number
  meanMs: number
  costBefore: number
  costAfter: number | null
  used: boolean | null
}

export interface Suggestion {
  table: string
  columns: string[]
  ddl: string
  reasons: string[]
  costBefore: number | null
  costAfter: number | null
  /** 1 - after/before (HypoPG only). */
  improvement: number | null
  /** Whether the planner would use it (HypoPG only). */
  used: boolean | null
  sizeBytes: number | null
  queries: QueryImpact[] | null
  /** Workload: time it would have saved (HypoPG) … */
  savedMs: number | null
  /** … or the time spent in the scans it targets (without HypoPG). */
  attributedMs: number | null
  costShare: number
}

export interface StatementAdvice {
  hypopg: HypoStatus
  costBefore?: number
  suggestions: Suggestion[]
  notes: string[]
  error: string | null
}

export interface WorkloadAdvice {
  hypopg: HypoStatus
  statements: {
    /** ok · missing (no extension in this db) · not-loaded (not in shared_preload_libraries) */
    state: 'ok' | 'missing' | 'not-loaded'
    since: string | null
    analyzed: number
    skipped: number
    serverMajor: number
  }
  suggestions: Suggestion[]
  notes: string[]
  errors: string[]
  tables: { table: string; seqScans: number; seqRowsRead: number; indexScans: number; liveRows: number }[]
  unusedIndexes: { table: string; index: string; sizeBytes: number; definition: string }[]
}

@Injectable({ providedIn: 'root' })
export class AdvisorApi {
  private readonly http = inject(HttpClient)

  statement(connectionId: string, sql: string): Observable<StatementAdvice> {
    return this.http.post<StatementAdvice>(`/api/advisor/${connectionId}/statement`, { sql })
  }

  workload(connectionId: string): Observable<WorkloadAdvice> {
    return this.http.get<WorkloadAdvice>(`/api/advisor/${connectionId}/workload`)
  }
}

export function formatBytes(n: number | null): string {
  if (n == null) return ''
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`
  if (n >= 1 << 20) return `${Math.round(n / (1 << 20))} MB`
  if (n >= 1 << 10) return `${Math.round(n / (1 << 10))} kB`
  return `${n} B`
}

export function formatMs(ms: number | null): string {
  if (ms == null) return ''
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)} h`
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)} min`
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.round(ms)} ms`
}
