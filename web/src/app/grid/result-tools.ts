import { HttpClient } from '@angular/common/http'
import { inject, Injectable } from '@angular/core'
import { catchError, map, Observable, of } from 'rxjs'

export type SortResult =
  { sorted: { column: number; descending: boolean } | null; capped: boolean } | { error: string }

/** Server-side operations on a result's buffered rows: sort it, search it. */
@Injectable({ providedIn: 'root' })
export class ResultTools {
  private readonly http = inject(HttpClient)

  sort(resultId: string, column: number | null, descending: boolean): Observable<SortResult> {
    return this.http
      .post<{ sorted: { column: number; descending: boolean } | null; capped: boolean }>(
        `/api/results/${resultId}/sort`,
        { column, descending },
      )
      .pipe(
        map((r): SortResult => r),
        catchError((e) =>
          of<SortResult>({ error: e?.error?.error ?? 'Could not sort (the result may be gone)' }),
        ),
      )
  }

  find(resultId: string, text: string): Observable<{ matches: [number, number][]; total: number }> {
    return this.http
      .post<{ matches: [number, number][]; total: number }>(`/api/results/${resultId}/find`, { text })
      .pipe(catchError(() => of({ matches: [] as [number, number][], total: 0 })))
  }
}
