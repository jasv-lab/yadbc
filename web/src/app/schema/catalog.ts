import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { inject, Injectable, signal } from '@angular/core'
import { catchError, map, Observable, shareReplay, throwError } from 'rxjs'

export type ObjectKind =
  'table' | 'view' | 'matview' | 'foreign' | 'sequence' | 'function' | 'procedure' | 'enum'

export interface CatalogObject {
  schema: string
  name: string
  oid: number
  kind: ObjectKind
  estRows: number | null
  comment: string | null
}

export interface CatalogObjects {
  schemas: string[]
  objects: CatalogObject[]
}

export interface CatalogColumn {
  name: string
  type: string
  nullable: boolean
  default: string | null
  primaryKey: boolean
  references: string | null
  comment: string | null
}

export interface Relation {
  columns: CatalogColumn[]
  indexes: { name: string; definition: string; unique: boolean; primary: boolean }[]
  constraints: { name: string; kind: string; definition: string }[]
  primaryKey: string[]
}

const RESERVED = new Set(
  (
    'all analyse analyze and any array as asc asymmetric authorization binary both case cast check collate collation ' +
    'column concurrently constraint create cross current_catalog current_date current_role current_schema current_time ' +
    'current_timestamp current_user default deferrable desc distinct do else end except false fetch for foreign freeze ' +
    'from full grant group having ilike in initially inner intersect into is isnull join lateral leading left like limit ' +
    'localtime localtimestamp natural not notnull null offset on only or order outer overlaps placing primary references ' +
    'returning right select session_user similar some symmetric system_user table tablesample then to trailing true union ' +
    'unique user using variadic verbose when where window with'
  ).split(' '),
)

/** Quotes an identifier only when Postgres would otherwise fold or reject it (mirrors the backend's Sql.Ident). */
export function ident(name: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(name) && !RESERVED.has(name) ? name : `"${name.replace(/"/g, '""')}"`
}

export const qualified = (o: { schema: string; name: string }) => `${ident(o.schema)}.${ident(o.name)}`

const toError = (e: HttpErrorResponse) =>
  throwError(() => new Error(e.error?.error ?? 'Catalog request failed'))

/**
 * Cached catalog per connection. `changed` bumps on refresh (manual, or after DDL run from yadbc)
 * so the tree reloads.
 */
@Injectable({ providedIn: 'root' })
export class Catalog {
  private readonly http = inject(HttpClient)
  private readonly objectsCache = new Map<string, Observable<CatalogObjects>>()
  private readonly relationCache = new Map<string, Observable<Relation>>()

  readonly changed = signal<{ connectionId: string; tick: number } | null>(null)

  objects(connectionId: string): Observable<CatalogObjects> {
    let o = this.objectsCache.get(connectionId)
    if (!o) {
      o = this.http.get<CatalogObjects>(`/api/catalog/${connectionId}/objects`).pipe(
        catchError((e) => {
          this.objectsCache.delete(connectionId)
          return toError(e)
        }),
        shareReplay(1),
      )
      this.objectsCache.set(connectionId, o)
    }
    return o
  }

  relation(connectionId: string, oid: number): Observable<Relation> {
    const key = `${connectionId}:${oid}`
    let r = this.relationCache.get(key)
    if (!r) {
      r = this.http.get<Relation>(`/api/catalog/${connectionId}/relation/${oid}`).pipe(
        catchError((e) => {
          this.relationCache.delete(key)
          return toError(e)
        }),
        shareReplay(1),
      )
      this.relationCache.set(key, r)
    }
    return r
  }

  definition(connectionId: string, kind: ObjectKind, oid: number): Observable<string> {
    return this.http.get<{ sql: string }>(`/api/catalog/${connectionId}/definition/${kind}/${oid}`).pipe(
      map((r) => r.sql),
      catchError(toError),
    )
  }

  refresh(connectionId: string) {
    this.objectsCache.delete(connectionId)
    for (const key of [...this.relationCache.keys()])
      if (key.startsWith(`${connectionId}:`)) this.relationCache.delete(key)
    this.changed.update((c) => ({ connectionId, tick: (c?.tick ?? 0) + 1 }))
  }
}
