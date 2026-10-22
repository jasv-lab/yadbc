import { Injectable } from '@angular/core'
import { filter, map, Observable, Subject, take } from 'rxjs'
import { apiToken } from './token'
import { ClientOp, Row, ServerEvent } from './protocol'

/**
 * The single WebSocket to the backend. Sessions live on the server per socket, so a reconnect
 * emits `socket-reset` and tabs must reopen theirs.
 */
@Injectable({ providedIn: 'root' })
export class QuerySocket {
  readonly events$ = new Subject<ServerEvent>()

  private ws: WebSocket | null = null
  private queue: ClientOp[] = []
  private reqId = 0
  private everOpened = false

  constructor() {
    this.connect()
  }

  send(op: ClientOp) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(op))
    else this.queue.push(op)
  }

  /** Rows [from, from+count). Grid windows cut long values; `full` returns them untruncated (copy). */
  window(resultId: string, from: number, count: number, full = false): Observable<Row[]> {
    const reqId = ++this.reqId
    const reply$ = this.events$.pipe(
      filter((e): e is Extract<ServerEvent, { ev: 'window' }> => e.ev === 'window' && e.reqId === reqId),
      take(1),
      map((e) => e.rows),
    )
    this.send({ op: 'window', reqId, resultId, from, count, full })
    return reply$
  }

  /** Sends a request op and resolves with the matching reply event (by reqId). */
  request<E extends ServerEvent['ev']>(
    ev: E,
    build: (reqId: number) => ClientOp,
  ): Observable<Extract<ServerEvent, { ev: E }>> {
    const reqId = ++this.reqId
    const reply$ = this.events$.pipe(
      filter(
        (e): e is Extract<ServerEvent, { ev: E }> => e.ev === ev && (e as { reqId?: number }).reqId === reqId,
      ),
      take(1),
    )
    this.send(build(reqId))
    return reply$
  }

  /** One full value; `undefined` when the result is gone (re-run or tab closed). */
  cell(resultId: string, row: number, col: number): Observable<string | null | undefined> {
    const reqId = ++this.reqId
    const reply$ = this.events$.pipe(
      filter((e): e is Extract<ServerEvent, { ev: 'cell' }> => e.ev === 'cell' && e.reqId === reqId),
      take(1),
      map((e) => (e.found ? (e.value ?? null) : undefined)),
    )
    this.send({ op: 'cell', reqId, resultId, row, col })
    return reply$
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//${location.host}/ws?token=${apiToken}`)
    this.ws = ws

    ws.onopen = () => {
      if (this.everOpened) this.events$.next({ ev: 'socket-reset' })
      this.everOpened = true
      const pending = this.queue
      this.queue = []
      pending.forEach((op) => ws.send(JSON.stringify(op)))
    }
    ws.onmessage = (msg) => this.events$.next(JSON.parse(msg.data) as ServerEvent)
    ws.onclose = () => {
      this.ws = null
      setTimeout(() => this.connect(), 1000)
    }
  }
}
