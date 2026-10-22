import { HttpClient } from '@angular/common/http'
import { inject, Injectable, signal } from '@angular/core'
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

@Injectable({ providedIn: 'root' })
export class Connections {
  private readonly http = inject(HttpClient)

  readonly list = signal<ConnectionProfile[]>([])

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
