import { HttpClient } from '@angular/common/http'
import { inject, Injectable, signal } from '@angular/core'
import { firstValueFrom } from 'rxjs'
import { ConnectionProfile } from '../core/protocol'

/** Result column types that can be searched for (the backend maps them to column type families). */
const SEARCHABLE = new Set([
  'uuid',
  'int2',
  'int4',
  'int8',
  'oid',
  'numeric',
  'float4',
  'float8',
  'money',
  'text',
  'varchar',
  'bpchar',
  'citext',
  'name',
  'date',
  'timestamp',
  'timestamptz',
  'inet',
  'cidr',
])

export const searchable = (type: string) => SEARCHABLE.has(type)

interface Candidate {
  schema: string
  table: string
  columns: string[]
  estRows: number
}

export interface SearchHit {
  schema: string
  table: string
  column: string
  /** Rows matched, 101 meaning "more than 100". */
  rows: number
}

export interface SearchState {
  connection: ConnectionProfile
  value: string
  type: string
  /** Column type family searched (uuid, int, text…), null when the type can't be searched. */
  family: string | null
  /** Tables to look in, and how many are done. */
  tables: number
  done: number
  hits: SearchHit[]
  /** Tables that couldn't be searched (timeout, no permission). */
  problems: { table: string; error: string }[]
  running: boolean
  stopped: boolean
}

const CONCURRENCY = 2

/**
 * "Find this value everywhere": plans the candidate columns, then searches table by table (two at a
 * time — the catalog pool's size) so progress shows and Stop works mid-way.
 */
@Injectable({ providedIn: 'root' })
export class ValueSearch {
  private readonly http = inject(HttpClient)
  readonly state = signal<SearchState | null>(null)
  private run = 0

  async start(connection: ConnectionProfile, value: string, type: string) {
    const id = ++this.run
    const base: SearchState = {
      connection,
      value,
      type,
      family: null,
      tables: 0,
      done: 0,
      hits: [],
      problems: [],
      running: true,
      stopped: false,
    }
    this.state.set(base)
    const api = `/api/catalog/${connection.id}/search`
    let plan: { family: string | null; candidates: Candidate[] }
    try {
      plan = await firstValueFrom(
        this.http.get<{ family: string | null; candidates: Candidate[] }>(`${api}/plan`, {
          params: { type },
        }),
      )
    } catch (e) {
      const error = (e as { error?: { error?: string } })?.error?.error ?? 'Could not read the catalog'
      this.state.set({ ...base, running: false, problems: [{ table: '', error }] })
      return
    }
    if (id !== this.run) return
    // Big tables last: the quick ones answer first.
    const queue = [...plan.candidates].sort((a, b) => a.estRows - b.estRows)
    this.patch(id, { family: plan.family, tables: queue.length, running: queue.length > 0 })

    const worker = async () => {
      for (let c = queue.shift(); c && id === this.run; c = queue.shift()) {
        try {
          const r = await firstValueFrom(
            this.http.post<{ hits: { column: string; rows: number }[]; error: string | null }>(
              `${api}/table`,
              {
                schema: c.schema,
                table: c.table,
                columns: c.columns,
                value,
              },
            ),
          )
          if (id !== this.run) return
          const s = this.state()!
          this.patch(id, {
            done: s.done + 1,
            hits: [
              ...s.hits,
              ...r.hits.map((h) => ({ schema: c.schema, table: c.table, column: h.column, rows: h.rows })),
            ],
            problems: r.error
              ? [...s.problems, { table: `${c.schema}.${c.table}`, error: r.error }]
              : s.problems,
          })
        } catch (e) {
          if (id !== this.run) return
          const s = this.state()!
          const error = (e as { error?: { error?: string } })?.error?.error ?? 'failed'
          this.patch(id, {
            done: s.done + 1,
            problems: [...s.problems, { table: `${c.schema}.${c.table}`, error }],
          })
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))
    if (id === this.run) this.patch(id, { running: false })
  }

  stop() {
    this.run++
    const s = this.state()
    if (s?.running) this.state.set({ ...s, running: false, stopped: true })
  }

  private patch(id: number, change: Partial<SearchState>) {
    const s = this.state()
    if (s && id === this.run) this.state.set({ ...s, ...change })
  }
}
