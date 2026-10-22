import { HttpClient } from '@angular/common/http'
import { inject, Injectable } from '@angular/core'
import { catchError, map, Observable, of, shareReplay } from 'rxjs'
import { TableRef } from './sql-nav'

export interface OutgoingKey {
  constraint: string
  table: TableRef
  column: string
  /** The referenced table's most readable column (name, code, email…), shown next to keys. */
  labelColumn: string | null
  estRows: number
}

export interface IncomingKey {
  constraint: string
  table: TableRef
  column: string
}

/** What a result column is related to (single-column keys only). */
export interface ColumnRelations {
  table: TableRef | null
  column: string | null
  enum: { type: string; values: string[] } | null
  references: OutgoingKey | null
  referencedBy: IncomingKey[]
}

export interface PickValue {
  value: string
  label: string | null
}

export interface PickValues {
  values: PickValue[]
  /** More than listed: search with q. */
  truncated: boolean
  error?: string
}

@Injectable({ providedIn: 'root' })
export class Relations {
  private readonly http = inject(HttpClient)
  private readonly cache = new Map<string, Observable<ColumnRelations[]>>()

  /** Per result, fetched once (results are immutable as far as their columns go). */
  of(resultId: string): Observable<ColumnRelations[]> {
    let r = this.cache.get(resultId)
    if (!r) {
      r = this.http.get<{ columns: ColumnRelations[] }>(`/api/results/${resultId}/relations`).pipe(
        map((x) => x.columns ?? []),
        catchError(() => of<ColumnRelations[]>([])),
        shareReplay(1),
      )
      this.cache.set(resultId, r)
    }
    return r
  }

  values(resultId: string, col: number, q?: string): Observable<PickValues> {
    return this.http
      .get<PickValues>(`/api/results/${resultId}/columns/${col}/values`, { params: q ? { q } : {} })
      .pipe(
        catchError(() => of<PickValues>({ values: [], truncated: false, error: 'Could not load values' })),
      )
  }
}
