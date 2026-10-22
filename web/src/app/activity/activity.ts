import { HttpClient } from '@angular/common/http'
import { inject, Injectable } from '@angular/core'
import { Observable } from 'rxjs'

/** A row of pg_stat_activity (client backends and autovacuum workers), as the backend sends it. */
export interface PgSession {
  pid: number
  database: string | null
  user: string | null
  application: string | null
  client: string | null
  backendType: string
  state: string | null
  waitType: string | null
  wait: string | null
  backendSeconds: number | null
  xactSeconds: number | null
  querySeconds: number | null
  stateSeconds: number | null
  /** pg_blocking_pids — only filled for sessions waiting on a lock. */
  blockedBy: number[]
  query: string | null
  /** This login may cancel / terminate it. */
  canSignal: boolean
}

export interface PgLock {
  pid: number
  lockType: string
  mode: string
  granted: boolean
  relation: string | null
  waitSeconds: number | null
}

export interface ActivitySnapshot {
  sessions: PgSession[]
  locks: PgLock[]
  /** The backend pid that read this snapshot (left out of it). */
  pid: number
  ms: number
}

export interface SignalResult {
  ok: boolean
  error: string | null
}

@Injectable({ providedIn: 'root' })
export class ActivityApi {
  private readonly http = inject(HttpClient)

  snapshot(connectionId: string): Observable<ActivitySnapshot> {
    return this.http.get<ActivitySnapshot>(`/api/activity/${connectionId}`)
  }

  signal(connectionId: string, pid: number, action: 'cancel' | 'terminate'): Observable<SignalResult> {
    return this.http.post<SignalResult>(`/api/activity/${connectionId}/${pid}/${action}`, null)
  }
}

export interface SessionRow {
  session: PgSession
  /** 0 for roots; waiters sit one level under the session they wait for. */
  depth: number
  /** How many sessions wait on this one, directly or down the chain. */
  blocking: number
  /** Blockers other than the one it's drawn under. */
  alsoBlockedBy: number[]
}

const STATE_ORDER: Record<string, number> = {
  active: 0,
  'idle in transaction (aborted)': 1,
  'idle in transaction': 1,
  'fastpath function call': 2,
  idle: 4,
}

/** How long the session has been in the state that matters: query running, transaction open, or idle. */
export function sessionAge(s: PgSession): number | null {
  if (s.state === 'active') return s.querySeconds ?? s.xactSeconds
  if (s.state?.startsWith('idle in transaction')) return s.xactSeconds
  return s.stateSeconds
}

/**
 * Sessions as a blocked-by forest. Each waiter is drawn under its first blocker that's in the list (a
 * session can wait on several — the rest go to `alsoBlockedBy`). Chains that block others come first,
 * the biggest pile-up on top; then everything else by state and age. pg_blocking_pids can't form a cycle
 * (the deadlock detector breaks those), but a visited set keeps a bad snapshot from looping anyway.
 */
export function blockingTree(sessions: PgSession[]): SessionRow[] {
  const byPid = new Map(sessions.map((s) => [s.pid, s]))
  const children = new Map<number, PgSession[]>()
  const parentOf = new Map<number, number>()
  for (const s of sessions) {
    const parent = s.blockedBy.find((p) => p !== s.pid && byPid.has(p))
    if (parent === undefined) continue
    parentOf.set(s.pid, parent)
    children.set(parent, [...(children.get(parent) ?? []), s])
  }

  const counted = new Map<number, number>()
  const count = (pid: number, seen = new Set<number>()): number => {
    if (counted.has(pid)) return counted.get(pid)!
    seen.add(pid)
    const n = (children.get(pid) ?? [])
      .filter((c) => !seen.has(c.pid))
      .reduce((sum, c) => sum + 1 + count(c.pid, seen), 0)
    counted.set(pid, n)
    return n
  }

  const byAge = (a: PgSession, b: PgSession) => (sessionAge(b) ?? 0) - (sessionAge(a) ?? 0)
  const roots = sessions
    .filter((s) => !parentOf.has(s.pid) || !byPid.has(parentOf.get(s.pid)!))
    .sort(
      (a, b) =>
        count(b.pid) - count(a.pid) ||
        (STATE_ORDER[a.state ?? ''] ?? 3) - (STATE_ORDER[b.state ?? ''] ?? 3) ||
        byAge(a, b),
    )

  const rows: SessionRow[] = []
  const visited = new Set<number>()
  const walk = (s: PgSession, depth: number) => {
    if (visited.has(s.pid)) return
    visited.add(s.pid)
    const parent = parentOf.get(s.pid)
    rows.push({
      session: s,
      depth,
      blocking: count(s.pid),
      alsoBlockedBy: s.blockedBy.filter((p) => p !== parent && p !== s.pid),
    })
    for (const c of (children.get(s.pid) ?? []).sort(byAge)) walk(c, depth + 1)
  }
  for (const r of roots) walk(r, 0)
  // Anything left is part of a cycle with no root; still show it.
  for (const s of sessions) walk(s, 0)
  return rows
}

/** 0.4s · 12s · 3m 05s · 1h 02m · 2d 3h */
export function formatAge(seconds: number | null): string {
  if (seconds == null) return ''
  if (seconds < 10) return `${seconds.toFixed(1)}s`
  const s = Math.floor(seconds)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
  if (s < 86400) return `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`
  return `${Math.floor(s / 86400)}d ${Math.floor(s / 3600) % 24}h`
}

/** Long-running queries and long-open transactions are the ones that hurt; waiting on a lock always is. */
export function ageSeverity(s: PgSession): 'ok' | 'warn' | 'bad' {
  if (s.waitType === 'Lock') return 'warn'
  if (s.state === 'idle' || s.backendType !== 'client backend') return 'ok'
  const age = sessionAge(s) ?? 0
  return age >= 600 ? 'bad' : age >= 60 ? 'warn' : 'ok'
}
