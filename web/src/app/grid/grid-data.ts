import { Observable, forkJoin, map, of } from 'rxjs'
import { Row } from '../core/protocol'
import { QuerySocket } from '../core/query-socket'

const PAGE = 200
/** Backend caps one window at 1000 rows. */
const MAX_FETCH = 1000

/**
 * Page cache over a backend result buffer. The grid asks for rows synchronously while painting;
 * missing pages are fetched over the socket and `onLoaded` triggers a repaint.
 */
export class GridData {
  private readonly pages = new Map<number, Row[]>()
  private readonly pending = new Set<number>()
  /** Previous contents after the buffer changed in place; shown until fresh pages arrive (no blank flash). */
  private stale = new Map<number, Row[]>()

  constructor(
    private readonly socket: QuerySocket,
    readonly resultId: string,
    private readonly onLoaded: () => void,
  ) {}

  /** Row if cached, else schedules its page and returns the stale copy (or undefined). */
  row(index: number): Row | undefined {
    const page = Math.floor(index / PAGE)
    const rows = this.pages.get(page)
    if (rows && index - page * PAGE < rows.length) return rows[index - page * PAGE]
    this.request(page)
    return this.stale.get(page)?.[index - page * PAGE]
  }

  /** The backend buffer changed (applied edits): re-fetch everything, painting old rows meanwhile. */
  refresh() {
    this.stale = new Map(this.pages)
    this.pages.clear()
  }

  /** While a result is still streaming the last page may be partial; forget it so it's re-fetched. */
  invalidateTail(rowCount: number) {
    const page = Math.floor(Math.max(rowCount - 1, 0) / PAGE)
    for (const p of this.pages.keys())
      if (p >= page && (this.pages.get(p)?.length ?? 0) < PAGE) this.pages.delete(p)
  }

  /**
   * All rows in [from, to) with untruncated values (for copy). Bypasses the page cache, which holds
   * grid windows with long values cut short.
   */
  range(from: number, to: number): Observable<Row[]> {
    const chunks: Observable<Row[]>[] = []
    for (let start = from; start < to; start += MAX_FETCH)
      chunks.push(this.socket.window(this.resultId, start, Math.min(MAX_FETCH, to - start), true))
    return chunks.length ? forkJoin(chunks).pipe(map((cs) => cs.flat())) : of([])
  }

  private request(page: number) {
    if (this.pending.has(page)) return
    this.pending.add(page)
    this.socket.window(this.resultId, page * PAGE, PAGE).subscribe((rows) => {
      this.pending.delete(page)
      this.pages.set(page, rows)
      this.stale.delete(page)
      this.onLoaded()
    })
  }
}
