import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { inject, Injectable } from '@angular/core'
import { catchError, Observable, throwError } from 'rxjs'
import { SchemaSnapshot } from './snapshot'

export interface ApplyResult {
  ok: boolean
  error?: string
  /** Which statement failed (0-based); nothing was changed — it all runs in one transaction. */
  statementIndex?: number | null
}

/** Snapshots for comparing and editing, and applying a generated script (SchemaChanges/ on the backend). */
@Injectable({ providedIn: 'root' })
export class SchemaChanges {
  private readonly http = inject(HttpClient)

  snapshot(connectionId: string, schemas: string[] | null): Observable<SchemaSnapshot> {
    return this.http
      .post<SchemaSnapshot>(`/api/schema-changes/${connectionId}/snapshot`, { schemas })
      .pipe(catchError(fail('Could not read the schema')))
  }

  /** One table (and its serial sequences): the table definition and the table editor. */
  table(connectionId: string, schema: string, name: string): Observable<SchemaSnapshot> {
    return this.http
      .post<SchemaSnapshot>(`/api/schema-changes/${connectionId}/snapshot`, {
        tableSchema: schema,
        tableName: name,
      })
      .pipe(catchError(fail('Could not read the table')))
  }

  /** All statements in one transaction; refused for prod connections (those go through an editor tab). */
  apply(connectionId: string, statements: string[]): Observable<ApplyResult> {
    return this.http
      .post<ApplyResult>(`/api/schema-changes/${connectionId}/apply`, { statements })
      .pipe(catchError((e) => [{ ok: false, error: message(e, 'The changes could not be applied') }]))
  }
}

function message(e: unknown, fallback: string): string {
  return e instanceof HttpErrorResponse && typeof e.error?.error === 'string' ? e.error.error : fallback
}

function fail(fallback: string) {
  return (e: unknown) => throwError(() => new Error(message(e, fallback)))
}
