/** Wire protocol of /ws — mirrors QuerySocketHandler / QuerySession on the backend. */

export type ConnectionEnv = 'local' | 'dev' | 'prod'

export interface ConnectionProfile {
  id: string
  name: string
  host: string
  port: number
  database: string
  username: string
  env: ConnectionEnv
  /** Claude (MCP) access; null = the environment's default (on for local/dev, off for prod). */
  mcp?: boolean | null
  /** Reach the database through SSH or kubectl port-forward; host/port are then as seen from the far end. */
  tunnel?: TunnelConfig | null
  /** Installed from the shared-connections broker; null = local. */
  shared?: SharedLink | null
  /** A "bring your own login" share whose login isn't entered yet. */
  needsLogin?: boolean
}

export type LoginMode = 'included' | 'own'

/** What the broker said about an installed share (see Sharing/SharedLink.cs). */
export interface SharedLink {
  shareId: string
  brokerUrl: string
  version: number
  loginMode: LoginMode
  /** The owner's ceiling for Claude (MCP). */
  mcpAllowed: boolean
  canEdit: boolean
  owners: string[]
  /** Deleted on the broker; still usable here until kept as local or removed. */
  orphaned: boolean
}

export type TunnelKind = 'ssh' | 'kubernetes'

export interface TunnelConfig {
  kind: TunnelKind
  /** Host or ~/.ssh/config alias. */
  sshHost?: string | null
  sshUser?: string | null
  sshPort?: number | null
  sshIdentityFile?: string | null
  /** Empty = kubectl's default (KUBECONFIG / ~/.kube/config). */
  kubeconfig?: string | null
  kubeContext?: string | null
  kubeNamespace?: string | null
  /** svc/name, pod/name, statefulset/name… */
  kubeTarget?: string | null
}

export interface ConnectionInput extends Omit<ConnectionProfile, 'id'> {
  password: string | null
}

export interface Statement {
  sql: string
  offset: number
}

export interface Column {
  name: string
  type: string
}

export type Row = (string | null)[]

export interface RunError {
  statementIndex?: number
  sqlState?: string
  messageText: string
  detail?: string
  hint?: string
  where?: string
  position?: number | null
}

export interface SessionInfo {
  serverVersion: string
  pid: number
  readOnly: boolean
}

export type ServerEvent =
  | { ev: 'opened'; tabId: string; ok: boolean; info?: SessionInfo; error?: string }
  | { ev: 'run-started'; tabId: string; runId: string }
  | { ev: 'result'; tabId: string; runId: string; index: number; resultId: string; columns: Column[] }
  | {
      ev: 'result-progress'
      resultId: string
      rowCount: number
      done: boolean
      totalRows?: number
      capped?: boolean
      queryMs?: number
      fetchMs?: number
    }
  | { ev: 'command'; tabId: string; runId: string; index: number; tag: string; elapsedMs: number }
  | { ev: 'notice'; tabId: string; severity: string; message: string }
  | {
      ev: 'run-finished'
      tabId: string
      runId: string
      ok: boolean
      cancelled: boolean
      elapsedMs: number
      error?: RunError
    }
  | { ev: 'window'; reqId: number; resultId: string; from: number; rows: Row[] }
  | { ev: 'cell'; reqId: number; found: boolean; value?: string | null }
  | { ev: 'session'; tabId: string; info: SessionInfo }
  | { ev: 'plan'; tabId: string; runId: string; analyze: boolean; plan: string; rolledBack: boolean }
  | {
      ev: 'edits-applied'
      reqId: number
      ok: boolean
      error?: string | null
      inTransaction?: boolean
      rowCount?: number
      failedRow?: number | null
      failedInsert?: number | null
    }
  | { ev: 'error'; message: string; tabId?: string }
  | { ev: 'socket-reset' }

export type ClientOp =
  | { op: 'open'; tabId: string; connectionId: string }
  | { op: 'run'; tabId: string; runId: string; statements: Statement[] }
  | { op: 'explain'; tabId: string; runId: string; statement: Statement; analyze: boolean }
  | { op: 'cancel'; tabId: string }
  | { op: 'window'; reqId: number; resultId: string; from: number; count: number; full?: boolean }
  | { op: 'cell'; reqId: number; resultId: string; row: number; col: number }
  | { op: 'close'; tabId: string }
  | { op: 'set-readonly'; tabId: string; readOnly: boolean }
  | { op: 'end-tx'; tabId: string; commit: boolean }
  | { op: 'edits-apply'; reqId: number; tabId: string; resultId: string; edits: EditSet }

export interface EditSet {
  updates: { row: number; col: number; value: string | null }[]
  deletes: number[]
  inserts: { values: Record<number, string | null> }[]
}
