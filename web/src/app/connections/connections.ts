import { HttpClient } from '@angular/common/http'
import { computed, inject, Injectable, signal } from '@angular/core'
import { Observable, tap } from 'rxjs'
import { ConnectionInput, ConnectionProfile } from '../core/protocol'

export interface TestResult {
  ok: boolean
  serverVersion?: string
  error?: string
  /** The test went through a (temporary) tunnel. */
  tunnel?: boolean
}

/** kubectl lookups for the Kubernetes tunnel fields; `error` = kubectl's last stderr line. */
export interface KubeList {
  items: string[]
  error: string | null
}

export interface KubeScope {
  kubeconfig?: string | null
  context?: string | null
  ns?: string | null
}

export interface ConnectionGroup {
  /** null: connections without a group, listed last */
  name: string | null
  connections: ConnectionProfile[]
}

const ENV_ORDER = { local: 0, dev: 1, prod: 2 } as const

/** Groups by name (case-insensitive), ungrouped last; inside a group local → dev → prod, then by name. */
export function grouped(list: ConnectionProfile[]): ConnectionGroup[] {
  const groups = new Map<string, ConnectionGroup>()
  for (const c of list) {
    const name = c.group?.trim() || null
    const key = name?.toLowerCase() ?? ''
    const g = groups.get(key) ?? { name, connections: [] }
    g.connections.push(c)
    groups.set(key, g)
  }
  const out = [...groups.values()]
  for (const g of out)
    g.connections.sort((a, b) => ENV_ORDER[a.env] - ENV_ORDER[b.env] || a.name.localeCompare(b.name))
  return out.sort((a, b) => (a.name === null ? 1 : b.name === null ? -1 : a.name.localeCompare(b.name)))
}

@Injectable({ providedIn: 'root' })
export class Connections {
  private readonly http = inject(HttpClient)

  readonly list = signal<ConnectionProfile[]>([])
  readonly groups = computed(() => grouped(this.list()))
  /** Group names in use, for suggestions. */
  readonly groupNames = computed(() => this.groups().flatMap((g) => (g.name ? [g.name] : [])))

  constructor() {
    this.reload().subscribe()
  }

  reload(): Observable<ConnectionProfile[]> {
    return this.http.get<ConnectionProfile[]>('/api/connections').pipe(tap((l) => this.list.set(l)))
  }

  get(id: string): ConnectionProfile | undefined {
    return this.list().find((c) => c.id === id)
  }

  save(input: ConnectionInput, id?: string): Observable<ConnectionProfile> {
    const req = id
      ? this.http.put<ConnectionProfile>(`/api/connections/${id}`, input)
      : this.http.post<ConnectionProfile>('/api/connections', input)
    return req.pipe(tap(() => this.reload().subscribe()))
  }

  remove(id: string): Observable<unknown> {
    return this.http.delete(`/api/connections/${id}`).pipe(tap(() => this.reload().subscribe()))
  }

  test(input: ConnectionInput, id?: string): Observable<TestResult> {
    return this.http.post<TestResult>('/api/connections/test', input, { params: id ? { id } : {} })
  }

  kubeConfigs(): Observable<string[]> {
    return this.http.get<string[]>('/api/kube/configs')
  }

  kube(what: 'contexts' | 'namespaces' | 'services', scope: KubeScope): Observable<KubeList> {
    const params: Record<string, string> = {}
    for (const [k, v] of Object.entries(scope)) if (v) params[k] = v
    return this.http.get<KubeList>(`/api/kube/${what}`, { params })
  }
}
