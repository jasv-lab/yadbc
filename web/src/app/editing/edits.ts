import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { computed, inject, Injectable, signal } from '@angular/core'
import { catchError, map, Observable, of, shareReplay, throwError } from 'rxjs'
import { EditSet } from '../core/protocol'
import { QuerySocket } from '../core/query-socket'
import { EditorTab, ResultView, Workspace } from '../workspace/workspace'

export interface Editability {
  columns: { editable: boolean; reason: string | null }[]
  rows: { editable: boolean; reason: string | null; table: string | null; primaryKey?: number[] | null }
  error?: string
}

export interface ApplyOutcome {
  ok: boolean
  message: string
}

/**
 * Staged (not yet applied) edits for one result. Nothing touches the database until Apply; the grid
 * renders these on top of the buffer. `version` bumps on every change so the grid knows to repaint.
 */
export class StagedEdits {
  readonly version = signal(0)
  /** Row whose statement caused the last rollback (conflict, invalid value). */
  readonly failedRow = signal<number | null>(null)
  readonly failedInsert = signal<number | null>(null)

  /** row → col → new value */
  readonly updates = new Map<number, Map<number, string | null>>()
  /** row → col → value it had when loaded (for tooltips and "unchanged again" detection) */
  readonly originals = new Map<number, Map<number, string | null>>()
  readonly deletes = new Set<number>()
  readonly inserts: Map<number, string | null>[] = []
  private readonly undoStack: (() => void)[] = []
  /** Collecting undo steps for one batch (a paste): they're undone together. */
  private batching: (() => void)[] | null = null

  readonly count = computed(() => {
    this.version()
    let cells = 0
    for (const m of this.updates.values()) cells += m.size
    return cells + this.deletes.size + this.inserts.length
  })

  constructor(readonly resultId: string) {}

  value(row: number, col: number): string | null | undefined {
    return this.updates.get(row)?.get(col)
  }

  isEdited(row: number, col: number): boolean {
    return this.updates.get(row)?.has(col) ?? false
  }

  original(row: number, col: number): string | null | undefined {
    return this.originals.get(row)?.get(col)
  }

  setCell(row: number, col: number, value: string | null, original: string | null) {
    const before = this.updates.get(row)?.has(col) ? this.updates.get(row)!.get(col)! : undefined
    this.write(row, col, value, original)
    this.push(() => (before === undefined ? this.unset(row, col) : this.write(row, col, before, original)))
  }

  setInsertCell(index: number, col: number, value: string | null) {
    const values = this.inserts[index]
    const had = values.has(col)
    const before = values.get(col)
    values.set(col, value)
    this.push(() => (had ? values.set(col, before ?? null) : values.delete(col)))
  }

  toggleDeletes(rows: number[]) {
    const removing = rows.every((r) => this.deletes.has(r))
    const changed = rows.filter((r) => this.deletes.has(r) === removing)
    changed.forEach((r) => (removing ? this.deletes.delete(r) : this.deletes.add(r)))
    this.push(() => changed.forEach((r) => (removing ? this.deletes.add(r) : this.deletes.delete(r))))
  }

  addRow(): number {
    this.inserts.push(new Map())
    const index = this.inserts.length - 1
    this.push(() => this.inserts.splice(index, 1))
    return index
  }

  removeInserts(indexes: number[]) {
    const removed = [...indexes].sort((a, b) => b - a).map((i) => [i, this.inserts.splice(i, 1)[0]] as const)
    this.push(() => [...removed].reverse().forEach(([i, values]) => this.inserts.splice(i, 0, values)))
  }

  /** Runs several changes as one undo step. */
  batch(changes: () => void) {
    this.batching = []
    try {
      changes()
    } finally {
      const steps = this.batching
      this.batching = null
      if (steps.length) this.push(() => [...steps].reverse().forEach((undo) => undo()))
    }
  }

  undo(): boolean {
    const step = this.undoStack.pop()
    if (!step) return false
    step()
    this.bump()
    return true
  }

  clear() {
    this.updates.clear()
    this.originals.clear()
    this.deletes.clear()
    this.inserts.length = 0
    this.undoStack.length = 0
    this.failedRow.set(null)
    this.failedInsert.set(null)
    this.bump()
  }

  toEditSet(): EditSet {
    const updates: EditSet['updates'] = []
    for (const [row, cols] of this.updates) for (const [col, value] of cols) updates.push({ row, col, value })
    return {
      updates,
      deletes: [...this.deletes],
      inserts: this.inserts.map((values) => ({ values: Object.fromEntries(values) })),
    }
  }

  private write(row: number, col: number, value: string | null, original: string | null) {
    if (!this.originals.get(row)?.has(col)) {
      if (!this.originals.has(row)) this.originals.set(row, new Map())
      this.originals.get(row)!.set(col, original)
    }
    // Typing the original value back means "no change".
    if (value === this.originals.get(row)!.get(col)) return this.unset(row, col)
    if (!this.updates.has(row)) this.updates.set(row, new Map())
    this.updates.get(row)!.set(col, value)
  }

  private unset(row: number, col: number) {
    this.updates.get(row)?.delete(col)
    if (this.updates.get(row)?.size === 0) this.updates.delete(row)
  }

  private push(undo: () => void) {
    if (this.batching) {
      this.batching.push(undo)
      return
    }
    this.undoStack.push(undo)
    this.failedRow.set(null)
    this.failedInsert.set(null)
    this.bump()
  }

  private bump() {
    this.version.update((v) => v + 1)
  }
}

@Injectable({ providedIn: 'root' })
export class Edits {
  private readonly http = inject(HttpClient)
  private readonly socket = inject(QuerySocket)
  private readonly workspace = inject(Workspace)

  private readonly staged = new Map<string, StagedEdits>()
  private readonly editability = new Map<string, Observable<Editability>>()
  /** Status line for the results header (e.g. why a cell isn't editable). */
  readonly message = signal<{ text: string; error: boolean } | null>(null)
  private messageTimer = 0

  for(resultId: string): StagedEdits {
    let s = this.staged.get(resultId)
    if (!s) {
      s = new StagedEdits(resultId)
      this.staged.set(resultId, s)
    }
    return s
  }

  peek(resultId: string): StagedEdits | undefined {
    return this.staged.get(resultId)
  }

  /** Staged changes across a tab's results — what a re-run or close would throw away. */
  pendingFor(tab: EditorTab): StagedEdits[] {
    return tab
      .results()
      .map((r) => this.staged.get(r.resultId))
      .filter((s): s is StagedEdits => !!s && s.count() > 0)
  }

  discardFor(tab: EditorTab) {
    for (const r of tab.results()) this.staged.get(r.resultId)?.clear()
  }

  editabilityOf(resultId: string): Observable<Editability> {
    let e = this.editability.get(resultId)
    if (!e) {
      e = this.http.get<Editability>(`/api/results/${resultId}/editability`).pipe(
        catchError(() =>
          of<Editability>({
            columns: [],
            rows: { editable: false, reason: null, table: null },
            error: 'Result is gone',
          }),
        ),
        shareReplay(1),
      )
      this.editability.set(resultId, e)
    }
    return e
  }

  preview(resultId: string): Observable<string> {
    return this.http
      .post<{ sql: string }>(`/api/results/${resultId}/edits/preview`, this.for(resultId).toEditSet())
      .pipe(
        map((r) => r.sql),
        catchError((e: HttpErrorResponse) => throwError(() => new Error(e.error?.error ?? 'Preview failed'))),
      )
  }

  apply(tab: EditorTab, result: ResultView): Observable<ApplyOutcome> {
    const staged = this.for(result.resultId)
    return this.socket
      .request('edits-applied', (reqId) => ({
        op: 'edits-apply',
        reqId,
        tabId: tab.id,
        resultId: result.resultId,
        edits: staged.toEditSet(),
      }))
      .pipe(
        map((e) => {
          if (!e.ok) {
            staged.failedRow.set(e.failedRow ?? null)
            staged.failedInsert.set(e.failedInsert ?? null)
            staged.version.update((v) => v + 1)
            return { ok: false, message: e.error ?? 'Apply failed' }
          }
          const n = staged.count()
          staged.clear()
          this.workspace.resultChanged(tab, result.resultId, e.rowCount ?? result.rowCount)
          return {
            ok: true,
            message: e.inTransaction
              ? `Applied ${n} ${n === 1 ? 'change' : 'changes'} inside your open transaction. Commit to keep them.`
              : `Applied ${n} ${n === 1 ? 'change' : 'changes'}`,
          }
        }),
      )
  }

  say(text: string, error = false) {
    clearTimeout(this.messageTimer)
    this.message.set({ text, error })
    this.messageTimer = window.setTimeout(() => this.message.set(null), error ? 6000 : 3000)
  }
}
