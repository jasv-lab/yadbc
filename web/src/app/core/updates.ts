import { HttpClient } from '@angular/common/http'
import { DestroyRef, inject, Injectable, signal } from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { catchError, exhaustMap, fromEvent, merge, Observable, of, switchMap, timer } from 'rxjs'
import { Session } from './session'

export interface UpdateStatus {
  /** False for a yadbc that isn't installed (dev runs): no updates at all. */
  enabled: boolean
  current: string | null
  available: string | null
  state: 'idle' | 'downloading' | 'ready'
  progress: number
  error: string | null
}

const POLL = 60_000

/**
 * New versions (Hosting/Updates.cs): the backend checks GitHub and downloads quietly; this follows its
 * status so the status bar can offer "Restart to update". Nothing restarts without that click.
 */
@Injectable({ providedIn: 'root' })
export class Updates {
  private readonly http = inject(HttpClient)
  private readonly session = inject(Session)

  readonly status = signal<UpdateStatus | null>(null)

  constructor() {
    // Cheap (a local call), so every minute: the button shows soon after the download finishes.
    merge(timer(5_000, POLL), fromEvent(window, 'focus'))
      .pipe(
        exhaustMap(() => this.http.get<UpdateStatus>('/api/update').pipe(catchError(() => of(null)))),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe((s) => this.status.set(s))
  }

  /** Saves the workspace, then lets the backend close yadbc; the updater starts the new version. */
  restart(): Observable<unknown> {
    return this.session.flush().pipe(
      catchError(() => of(null)),
      switchMap(() => this.http.post('/api/update/restart', {})),
    )
  }
}
