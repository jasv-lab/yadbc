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
}

/** Saved, named statements (backend snippets.json). Loaded once; every change updates the list in place. */
@Injectable({ providedIn: 'root' })
export class Snippets {
  private readonly http = inject(HttpClient)
  readonly all = signal<Snippet[]>([])

  constructor() {
    this.http
      .get<Snippet[]>('/api/snippets')
      .subscribe({ next: (s) => this.all.set(s), error: () => undefined })
  }

  /** The ones offered on a connection: its own and the global ones. */
  forConnection(connectionId: string): Snippet[] {
    return this.all().filter((s) => s.connectionId === connectionId || s.connectionId === null)
  }

  save(snippet: Omit<Snippet, 'id' | 'updated'>, id: string = crypto.randomUUID()): Observable<Snippet> {
    return this.http
      .put<Snippet>(`/api/snippets/${id}`, snippet)
      .pipe(
        tap((saved) =>
          this.all.update((all) =>
            [...all.filter((s) => s.id !== saved.id), saved].sort((a, b) =>
              a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
            ),
          ),
        ),
      )
  }

  remove(id: string): Observable<unknown> {
    return this.http
      .delete(`/api/snippets/${id}`)
      .pipe(tap(() => this.all.update((all) => all.filter((s) => s.id !== id))))
  }
}
