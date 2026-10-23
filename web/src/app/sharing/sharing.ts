import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { DestroyRef, inject, Injectable, signal } from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import {
  catchError,
  exhaustMap,
  filter,
  fromEvent,
  map,
  merge,
  Observable,
  of,
  Subject,
  switchMap,
  takeWhile,
  tap,
  timer,
} from 'rxjs'
import { Connections } from '../connections/connections'
import { ConnectionEnv, ConnectionProfile, LoginMode } from '../core/protocol'

export interface Person {
  id: string
  name: string
  email: string | null
}

export interface SharingStatus {
  brokerUrl: string | null
  signedIn: boolean
  signingIn: boolean
  user: Person | null
  isAdmin: boolean
  error: string | null
}

/** A share as the catalog lists it (Yadbc.Contracts Share). */
export interface Share {
  id: string
  name: string
  host: string
  port: number
  database: string
  env: ConnectionEnv
  loginMode: LoginMode
  tunnel: {
    kind: 'ssh' | 'kubernetes'
    sshHost?: string | null
    kubeNamespace?: string | null
    kubeTarget?: string | null
  } | null
  mcpAllowed: boolean
  owners: Person[]
  version: number
  updatedBy: Person
  updatedAt: string
  username: string | null
  hasLogin: boolean
  installs: number
  installedByMe: boolean
  canEdit: boolean
}

export interface CatalogEntry {
  share: Share
  /** The local connection it's installed as, if it is. */
  installedAs: string | null
}

export interface ShareRequest {
  includeLogin: boolean
  mcpAllowed: boolean
  owners?: string[] | null
}

const SYNC_EVERY = 5 * 60_000
const NONE: SharingStatus = {
  brokerUrl: null,
  signedIn: false,
  signingIn: false,
  user: null,
  isAdmin: false,
  error: null,
}

/** The message a sharing call failed with (the host passes the broker's own words through). */
export function sharingError(e: unknown): string {
  return e instanceof HttpErrorResponse && typeof e.error?.error === 'string'
    ? e.error.error
    : 'The request failed.'
}

/**
 * Shared connections (docs/design.md §10b), optional: status of the broker sign-in, the catalog, and
 * a sync of installed shares on start, when the window comes back into focus, and every 5 minutes.
 */
@Injectable({ providedIn: 'root' })
export class Sharing {
  private readonly http = inject(HttpClient)
  private readonly connections = inject(Connections)
  private readonly sync$ = new Subject<void>()

  readonly status = signal<SharingStatus>(NONE)

  constructor() {
    this.refreshStatus().subscribe()
    merge(timer(1500, SYNC_EVERY), fromEvent(window, 'focus'), this.sync$)
      .pipe(
        filter(() => this.status().signedIn),
        exhaustMap(() => this.syncNow()),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe()
  }

  refreshStatus(): Observable<SharingStatus> {
    return this.http.get<SharingStatus>('/api/sharing/status').pipe(
      catchError(() => of(NONE)),
      tap((s) => this.status.set(s)),
    )
  }

  sync() {
    this.sync$.next()
  }

  private syncNow() {
    return this.http.post<{ changed: number }>('/api/sharing/sync', {}).pipe(
      switchMap((r) => (r.changed ? this.connections.reload() : of(null))),
      catchError((e) => {
        if (e instanceof HttpErrorResponse && e.error?.signedOut) this.refreshStatus().subscribe()
        return of(null)
      }),
    )
  }

  /**
   * Opens the broker's sign-in in the system browser (the host does that; in a plain browser tab the
   * page opens it) and follows the status until the round trip comes back.
   */
  signIn(brokerUrl: string): Observable<SharingStatus> {
    return this.http.post<{ url: string; opened: boolean }>('/api/sharing/sign-in', { brokerUrl }).pipe(
      tap((r) => {
        if (!r.opened) window.open(r.url, '_blank')
      }),
      switchMap(() => timer(1000, 1500)),
      switchMap(() => this.refreshStatus()),
      takeWhile((s) => !s.signedIn && s.signingIn, true),
      tap((s) => {
        if (s.signedIn) this.sync()
      }),
    )
  }

  signOut(): Observable<unknown> {
    return this.http.post('/api/sharing/sign-out', {}).pipe(
      switchMap(() => this.refreshStatus()),
      switchMap(() => this.connections.reload()),
    )
  }

  catalog(): Observable<CatalogEntry[]> {
    return this.http.get<CatalogEntry[]>('/api/sharing/catalog')
  }

  users(): Observable<Person[]> {
    return this.http.get<Person[]>('/api/sharing/users').pipe(catchError(() => of([])))
  }

  /** Into one of your groups (or none); the group is yours, not the share's. */
  install(shareId: string, group: string | null): Observable<ConnectionProfile> {
    return this.http
      .post<ConnectionProfile>(`/api/sharing/install/${shareId}`, {}, { params: group ? { group } : {} })
      .pipe(this.reloading())
  }

  /** Share a local connection, or change how an already shared one is shared. */
  share(profileId: string, req: ShareRequest): Observable<ConnectionProfile> {
    return this.http.post<ConnectionProfile>(`/api/sharing/share/${profileId}`, req).pipe(this.reloading())
  }

  stop(profileId: string): Observable<ConnectionProfile> {
    return this.http.post<ConnectionProfile>(`/api/sharing/stop/${profileId}`, {}).pipe(this.reloading())
  }

  keepLocal(profileId: string): Observable<ConnectionProfile> {
    return this.http
      .post<ConnectionProfile>(`/api/sharing/keep-local/${profileId}`, {})
      .pipe(this.reloading())
  }

  private reloading<T>() {
    return (source: Observable<T>) =>
      source.pipe(switchMap((v) => this.connections.reload().pipe(map(() => v))))
  }
}

/** "Ada Lovelace" → "AL"; the mark on a shared connection. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts.at(-1)![0] : '')).toUpperCase()
}
