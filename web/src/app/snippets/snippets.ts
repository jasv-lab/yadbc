import { HttpClient } from '@angular/common/http'
import { inject, Injectable, signal } from '@angular/core'
import { Observable, tap } from 'rxjs'

export interface Snippet {
  id: string
  name: string
  sql: string
  /** null: offered on every connection. */
  connectionId: string | null
  updated: string
  /** From the shared-connections broker; null = only yours. */
  shared: SnippetSharing | null
}

export interface SnippetSharing {
  /** Who shared it. */
  by: string
  /** Its author, the connection's owners and admins can change it; everyone else can copy it. */
  canEdit: boolean
}

/**
 * Saved, named statements: your own (backend snippets.json) and the team's shared ones (from the broker,
 * refreshed by the sharing sync). Loaded once; every change updates the list in place.
 */
@Injectable({ providedIn: 'root' })
export class Snippets {
  private readonly http = inject(HttpClient)
  readonly all = signal<Snippet[]>([])

  constructor() {
    this.reload().subscribe({ error: () => undefined })
  }

  reload(): Observable<Snippet[]> {
    return this.http.get<Snippet[]>('/api/snippets').pipe(tap((s) => this.all.set(s)))
  }

  /** The ones offered on a connection: its own and the global ones. */
  forConnection(connectionId: string): Snippet[] {
    return this.all().filter((s) => s.connectionId === connectionId || s.connectionId === null)
  }

  save(
    snippet: Omit<Snippet, 'id' | 'updated' | 'shared'>,
    id: string = crypto.randomUUID(),
  ): Observable<Snippet> {
    return this.http.put<Snippet>(`/api/snippets/${id}`, snippet).pipe(tap((saved) => this.replace(saved)))
  }

  remove(id: string): Observable<unknown> {
    return this.http
      .delete(`/api/snippets/${id}`)
      .pipe(tap(() => this.all.update((all) => all.filter((s) => s.id !== id))))
  }

  /** With everyone using its connection (a shared one), or with the whole team (every connection). */
  share(id: string): Observable<Snippet> {
    return this.http.post<Snippet>(`/api/snippets/${id}/share`, {}).pipe(tap((s) => this.replace(s)))
  }

  /** Back to being only yours. */
  stopSharing(id: string): Observable<Snippet> {
    return this.http.post<Snippet>(`/api/snippets/${id}/stop-sharing`, {}).pipe(tap((s) => this.replace(s)))
  }

  private replace(snippet: Snippet) {
    this.all.update((all) =>
      [...all.filter((s) => s.id !== snippet.id), snippet].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
      ),
    )
  }
}
