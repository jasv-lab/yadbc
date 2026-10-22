import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  untracked,
  ViewEncapsulation,
} from '@angular/core'
import { firstValueFrom } from 'rxjs'
import { Column, Row } from '../core/protocol'
import { QuerySocket } from '../core/query-socket'
import { Edits, StagedEdits } from '../editing/edits'
import { CellInspector } from '../inspector/cell-inspector'
import { PickValue, Relations } from '../navigation/relations'
import { tableSql } from '../navigation/sql-nav'
import { ResultView } from '../workspace/workspace'
import { GridData } from './grid-data'
import { ResultTools } from './result-tools'
import { parseTsv } from './tsv'

const ROW = 24
const HEADER = 40
const GUTTER = 56
const PAD = 8
const MIN_COL = 56
const MAX_COL = 420
const CELL_FONT = '12.5px "JetBrains Mono"'
const NUMERIC = new Set(['int2', 'int4', 'int8', 'numeric', 'float4', 'float8', 'money', 'oid'])
const CONTROL = /\r\n|[\r\n\t]/g
const CONTROL_MARK: Record<string, string> = { '\r\n': '↵', '\n': '↵', '\r': '↵', '\t': '⇥' }

/**
 * Cells are one line: line breaks and tabs become visible marks instead of wrapping into a 24px row.
 * Display only — copy, the inspector and the cell editor use the real value.
 */
function displayValue(v: string): string {
  return v.replace(CONTROL, (m) => CONTROL_MARK[m])
}

interface Cell {
  r: number
  c: number
}

/** What a click landed on: a cell, a column header, a row number, or the top-left corner (everything). */
interface Hit {
  zone: 'cell' | 'header' | 'gutter' | 'corner'
  r: number
  c: number
}

/**
 * Hand-written virtualized grid, deliberately outside Angular change detection: a recycled pool of
 * row/cell elements, precomputed column offsets, and on scroll only textContent/position writes.
 * Rows and columns are both virtualized; data comes from the backend buffer page by page.
 * Staged edits (see Edits) are painted on top; rows being inserted live past the buffer's end.
 */
@Component({
  selector: 'y-result-grid',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  host: { class: 'relative block h-full w-full' },
  template: `<div class="yg-viewport" tabindex="0">
      <div class="yg-header"></div>
      <div class="yg-body"></div>
      <textarea class="yg-editor" spellcheck="false" hidden></textarea>
      <div class="yg-picker" hidden></div>
    </div>
    <div class="yg-find" hidden>
      <input placeholder="Find in results" spellcheck="false" />
      <span class="yg-find-count"></span>
      <button data-dir="-1" title="Previous (Shift+Enter)">↑</button>
      <button data-dir="1" title="Next (Enter, F3)">↓</button>
      <button data-close title="Close (Esc)">×</button>
    </div>`,
  styles: `
    .yg-viewport {
      position: relative;
      height: 100%;
      width: 100%;
      overflow: auto;
      outline: none;
      background: var(--bg-raised);
    }
    .yg-header {
      position: sticky;
      top: 0;
      z-index: 2;
      height: ${HEADER}px;
      background: var(--bg-sunken);
      border-bottom: 1px solid var(--border);
    }
    .yg-body {
      position: relative;
    }
    .yg-row {
      position: absolute;
      left: 0;
      height: ${ROW}px;
      contain: strict;
    }
    .yg-row.odd {
      background: rgb(127 127 127 / 0.035);
    }
    .yg-cell,
    .yg-hcell {
      position: absolute;
      top: 0;
      box-sizing: border-box;
      padding: 0 ${PAD}px;
      overflow: hidden;
      white-space: pre;
      text-overflow: ellipsis;
      border-right: 1px solid var(--border);
    }
    .yg-cell {
      height: ${ROW}px;
      /* After the font shorthand, which resets line-height to normal (text then sat 3px high). */
      font: ${CELL_FONT};
      line-height: ${ROW}px;
      font-variant-numeric: tabular-nums;
      border-bottom: 1px solid var(--border);
      cursor: cell;
    }
    .yg-cell.num {
      text-align: right;
    }
    .yg-cell.null,
    .yg-cell.default {
      color: var(--fg-faint);
      font-style: italic;
    }
    .yg-cell.empty {
      color: var(--fg-faint);
    }
    .yg-cell.sel {
      background: var(--bg-selected);
    }
    .yg-cell.edited {
      background: var(--warning-bg);
      box-shadow: inset 2px 0 0 var(--warning);
    }
    .yg-cell.sel.edited {
      background: color-mix(in srgb, var(--warning-bg) 60%, var(--bg-selected));
    }
    .yg-row.deleted .yg-cell:not(.yg-gutter) {
      text-decoration: line-through;
      color: var(--fg-faint);
    }
    .yg-row.deleted .yg-gutter {
      box-shadow: inset -2px 0 0 var(--danger);
      color: var(--danger);
    }
    .yg-row.inserted .yg-gutter {
      box-shadow: inset -2px 0 0 var(--warning);
      color: var(--warning);
    }
    .yg-row.failed .yg-cell {
      background: var(--danger-bg);
    }
    .yg-cell.active {
      box-shadow: inset 0 0 0 2px var(--accent);
    }
    .yg-gutter {
      position: sticky;
      left: 0;
      z-index: 1;
      width: ${GUTTER}px;
      text-align: right;
      color: var(--fg-faint);
      background: var(--bg-sunken);
      cursor: pointer;
    }
    .yg-hcell {
      height: ${HEADER}px;
      padding-top: 5px;
      line-height: 15px;
      cursor: pointer;
      user-select: none;
    }
    /* Header and row numbers echo the selection; opaque because both are sticky over the cells. */
    .yg-gutter.in,
    .yg-hcell.in .n {
      color: var(--accent);
    }
    .yg-gutter.full,
    .yg-hcell.full {
      background: color-mix(in srgb, var(--accent) 22%, var(--bg-sunken));
      color: var(--fg);
    }
    .yg-sort {
      position: absolute;
      right: 10px;
      top: 4px;
      padding: 0 3px;
      border-radius: 3px;
      font-size: 11px;
      line-height: 15px;
      color: var(--fg-faint);
      cursor: pointer;
      opacity: 0;
    }
    .yg-hcell:hover .yg-sort,
    .yg-sort.on {
      opacity: 1;
    }
    .yg-sort.on {
      color: var(--accent);
      font-weight: 600;
    }
    .yg-sort:hover {
      background: var(--bg-hover);
      color: var(--fg);
    }
    .yg-cell.found {
      background: color-mix(in srgb, var(--warning) 22%, transparent);
    }
    .yg-cell.found-cur {
      background: color-mix(in srgb, var(--warning) 45%, transparent);
      box-shadow: inset 0 0 0 2px var(--warning);
    }
    .yg-find {
      position: absolute;
      top: 46px;
      right: 18px;
      z-index: 5;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 6px;
      border-radius: 6px;
      border: 1px solid var(--border-strong);
      background: var(--bg-raised);
      box-shadow: 0 6px 18px rgb(0 0 0 / 0.25);
      font-size: 12px;
    }
    .yg-find[hidden] {
      display: none;
    }
    .yg-find input {
      width: 200px;
      height: 24px;
      padding: 0 6px;
      border-radius: 4px;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--fg);
      font: 12px var(--font-mono);
      outline: none;
    }
    .yg-find input:focus {
      border-color: var(--accent);
    }
    .yg-find-count {
      min-width: 64px;
      text-align: center;
      color: var(--fg-muted);
      font-variant-numeric: tabular-nums;
    }
    .yg-find button {
      width: 22px;
      height: 22px;
      border-radius: 4px;
      color: var(--fg-muted);
    }
    .yg-find button:hover {
      background: var(--bg-hover);
      color: var(--fg);
    }
    .yg-hcell .n {
      display: block;
      padding-right: 18px;
      font-weight: 500;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--fg);
    }
    .yg-hcell .t {
      display: block;
      font: 10.5px 'JetBrains Mono';
      color: var(--fg-faint);
    }
    .yg-hcell.num {
      text-align: right;
    }
    .yg-hcell.corner {
      position: sticky;
      left: 0;
      z-index: 1;
      background: var(--bg-sunken);
    }
    .yg-hcell.corner.full {
      background: color-mix(in srgb, var(--accent) 22%, var(--bg-sunken));
    }
    /* Inside the header cell (it clips overflow); the next header would cover anything past its edge. */
    .yg-resize {
      position: absolute;
      right: 0;
      top: 0;
      width: 8px;
      height: 100%;
      cursor: col-resize;
      z-index: 1;
    }
    .yg-resize:hover::after,
    .yg-resize.drag::after {
      content: '';
      position: absolute;
      right: 0;
      top: 6px;
      bottom: 6px;
      width: 2px;
      border-radius: 1px;
      background: var(--accent);
    }
    .yg-picker {
      position: absolute;
      z-index: 4;
      min-width: 240px;
      max-width: 440px;
      max-height: 264px;
      overflow: auto;
      padding: 4px 0;
      border-radius: 6px;
      border: 1px solid var(--border-strong);
      background: var(--bg-raised);
      box-shadow: 0 8px 24px rgb(0 0 0 / 0.3);
      font-size: 12.5px;
    }
    .yg-pick-title {
      padding: 2px 10px 4px;
      font-size: 11px;
      color: var(--fg-faint);
      white-space: nowrap;
    }
    .yg-pick {
      display: flex;
      gap: 10px;
      padding: 3px 10px;
      white-space: nowrap;
      cursor: pointer;
    }
    .yg-pick .v {
      font: ${CELL_FONT};
    }
    .yg-pick .l {
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--fg-muted);
    }
    .yg-pick.on {
      background: var(--bg-selected);
    }
    .yg-pick.cur .v::after {
      content: ' ✓';
      color: var(--accent);
    }
    .yg-pick-empty {
      padding: 3px 10px;
      color: var(--fg-faint);
    }
    .yg-editor {
      position: absolute;
      z-index: 3;
      box-sizing: border-box;
      min-height: ${ROW}px;
      padding: 2px ${PAD - 1}px;
      border: 2px solid var(--accent);
      border-radius: 2px;
      background: var(--bg-raised);
      color: var(--fg);
      font: ${CELL_FONT};
      line-height: 18px;
      resize: none;
      outline: none;
      box-shadow: 0 6px 18px rgb(0 0 0 / 0.25);
    }
  `,
})
export class ResultGrid {
  readonly result = input<ResultView | null>(null)
  /** Why editing is blocked right now (read-only session, query running), or null. */
  readonly editBlock = input<string | null>(null)

  private readonly socket = inject(QuerySocket)
  private readonly host = inject(ElementRef<HTMLElement>)
  private readonly inspector = inject(CellInspector)
  private readonly edits = inject(Edits)
  private readonly relations = inject(Relations)
  private readonly tools = inject(ResultTools)
  /** Sorted by (buffer reordered on the server), or null for the query's own order. */
  private sort: { col: number; desc: boolean } | null = null
  private findBar!: HTMLDivElement
  private findInput!: HTMLInputElement
  private findCount!: HTMLSpanElement
  /** Matches of the find bar as "row:col", in row order, and which one is current. */
  private found = new Set<string>()
  private foundList: Cell[] = []
  private foundIndex = -1
  private foundTotal = 0
  private findTimer?: ReturnType<typeof setTimeout>

  private viewport!: HTMLDivElement
  private header!: HTMLDivElement
  private body!: HTMLDivElement
  private editor!: HTMLTextAreaElement
  private pickerEl!: HTMLDivElement
  /** Enum labels / referenced keys offered while editing a cell; null when the column has none. */
  private picker: {
    cell: Cell
    all: PickValue[]
    items: PickValue[]
    /** Too many to list: filtering asks the server. */
    search: boolean
    current: string | null
    highlight: number
    title: string
    timer?: ReturnType<typeof setTimeout>
  } | null = null
  private rows: { el: HTMLDivElement; gutter: HTMLDivElement; cells: HTMLDivElement[] }[] = []
  private hcells: { el: HTMLDivElement; base: string }[] = []
  /** The columns the header cells were built for. */
  private headerColumns: Column[] | null = null
  private corner: HTMLDivElement | null = null

  private data: GridData | null = null
  private staged: StagedEdits | null = null
  private version = 0
  private columns: Column[] = []
  private widths: number[] = []
  private offsets: number[] = [0]
  /** Rows in the backend buffer; staged inserts are painted after them. */
  private rowCount = 0
  private measured = false
  private anchor: Cell | null = null
  private focus: Cell | null = null
  private editing: { cell: Cell; original: string | null } | null = null
  private frame = 0
  private ready = false

  constructor() {
    const destroyRef = inject(DestroyRef)

    afterNextRender(() => {
      const root = this.host.nativeElement as HTMLElement
      this.viewport = root.querySelector('.yg-viewport')!
      this.header = root.querySelector('.yg-header')!
      this.body = root.querySelector('.yg-body')!
      this.editor = root.querySelector('.yg-editor')!
      this.pickerEl = root.querySelector('.yg-picker')!
      this.editor.addEventListener('input', () => this.filterPicker())
      this.viewport.addEventListener('scroll', () => this.schedule(), { passive: true })
      this.viewport.addEventListener('mousedown', (e) => this.onMouseDown(e))
      this.viewport.addEventListener('dblclick', (e) => this.onDoubleClick(e))
      this.viewport.addEventListener('keydown', (e) => this.onKeyDown(e))
      // Ctrl+V from Excel & co. The paste event carries the text, no clipboard permission needed.
      this.viewport.addEventListener('paste', (e) => {
        const text = e.clipboardData?.getData('text/plain')
        if (text && !this.editing) {
          e.preventDefault()
          void this.paste(text)
        }
      })
      this.findBar = root.querySelector('.yg-find')!
      this.findInput = this.findBar.querySelector('input')!
      this.findCount = this.findBar.querySelector('.yg-find-count')!
      this.findInput.addEventListener('input', () => {
        clearTimeout(this.findTimer)
        this.findTimer = setTimeout(() => this.runFind(), 180)
      })
      this.findInput.addEventListener('keydown', (e) => this.onFindKey(e))
      this.findBar.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest('button')
        if (!b) return
        if (b.hasAttribute('data-close')) this.closeFind()
        else this.stepFind(Number(b.getAttribute('data-dir')))
      })
      this.editor.addEventListener('keydown', (e) => this.onEditorKey(e))
      this.editor.addEventListener('blur', () => this.commitEdit())
      const ro = new ResizeObserver(() => this.schedule())
      ro.observe(this.viewport)
      destroyRef.onDestroy(() => ro.disconnect())
      this.ready = true
      this.load(untracked(this.result))
    })

    effect(() => {
      const result = this.result()
      untracked(() => this.ready && this.load(result))
    })

    // Repaint (and resize for added/removed inserts) whenever staged edits change.
    effect(() => {
      const result = this.result()
      if (!result) return
      this.edits.for(result.resultId).version()
      untracked(() => this.ready && this.layout())
    })
  }

  private get totalRows() {
    return this.rowCount + (this.staged?.inserts.length ?? 0)
  }

  private load(result: ResultView | null) {
    if (!result) {
      this.cancelEdit()
      this.data = null
      this.staged = null
      this.columns = []
      this.rowCount = 0
      this.layout()
      return
    }
    if (this.data?.resultId !== result.resultId) {
      this.cancelEdit()
      this.data = new GridData(this.socket, result.resultId, () => this.onPageLoaded())
      this.staged = this.edits.for(result.resultId)
      this.version = result.version ?? 0
      this.columns = result.columns
      this.measured = false
      this.widths = result.columns.map((c) => this.headerWidth(c))
      this.anchor = this.focus = null
      this.sort = null
      this.clearFound()
      this.viewport.scrollTop = 0
      this.viewport.scrollLeft = 0
    } else if ((result.version ?? 0) !== this.version) {
      // Applied edits changed the buffer in place: re-fetch, keeping widths, scroll, focus and old rows on screen.
      this.version = result.version ?? 0
      this.data.refresh()
    } else if (result.rowCount !== this.rowCount) {
      this.data.invalidateTail(this.rowCount)
    }
    this.rowCount = result.rowCount
    if (this.focus && this.focus.r >= this.totalRows) this.anchor = this.focus = null
    this.layout()
  }

  private onPageLoaded() {
    if (!this.measured) this.measure()
    this.schedule()
  }

  /** Initial widths from the first page, measured in the mono font's real metrics. */
  private measure() {
    const ctx = document.createElement('canvas').getContext('2d')!
    ctx.font = CELL_FONT
    const sample: Row[] = []
    for (let i = 0; i < Math.min(this.rowCount, 200); i++) {
      const r = this.data!.row(i)
      if (r) sample.push(r)
    }
    if (!sample.length) return
    this.widths = this.columns.map((c, ci) => {
      let w = this.headerWidth(c)
      for (const row of sample) {
        const v = row[ci]
        if (v)
          w = Math.max(
            w,
            ctx.measureText(displayValue(v.length > 80 ? v.slice(0, 80) : v)).width + PAD * 2 + 2,
          )
      }
      return Math.round(Math.min(Math.max(w, MIN_COL), MAX_COL))
    })
    this.measured = true
    this.layout()
  }

  private headerWidth(c: Column): number {
    const ctx = document.createElement('canvas').getContext('2d')!
    ctx.font = '500 13px "Segoe UI Variable Text", "Segoe UI", system-ui'
    const nameW = ctx.measureText(c.name).width
    ctx.font = '10.5px "JetBrains Mono"'
    return Math.min(Math.max(nameW, ctx.measureText(c.type).width) + PAD * 2 + 4, MAX_COL)
  }

  private layout() {
    this.offsets = [0]
    for (const w of this.widths) this.offsets.push(this.offsets[this.offsets.length - 1] + w)
    const total = GUTTER + this.offsets[this.offsets.length - 1]
    this.header.style.width = `${total}px`
    this.body.style.width = `${total}px`
    this.body.style.height = `${this.totalRows * ROW}px`
    // Rebuild only for new columns. Rebuilding on every width change (as a resize drag does each frame)
    // would remove the grip being dragged from the DOM — and its pointer capture with it.
    if (this.headerColumns !== this.columns) this.renderHeader()
    else this.positionHeader()
    this.schedule()
  }

  private positionHeader() {
    this.hcells.forEach((h, i) => {
      h.el.style.left = `${GUTTER + this.offsets[i]}px`
      h.el.style.width = `${this.widths[i]}px`
    })
  }

  private renderHeader() {
    this.headerColumns = this.columns
    this.header.textContent = ''
    const corner = document.createElement('div')
    corner.className = 'yg-hcell corner'
    corner.style.width = `${GUTTER}px`
    corner.title = 'Select all (Ctrl+A)'
    this.header.appendChild(corner)
    this.corner = corner
    this.hcells = []
    this.columns.forEach((c, i) => {
      const h = document.createElement('div')
      const base = NUMERIC.has(c.type) ? 'yg-hcell num' : 'yg-hcell'
      h.className = base
      this.hcells.push({ el: h, base })
      h.style.left = `${GUTTER + this.offsets[i]}px`
      h.style.width = `${this.widths[i]}px`
      h.title = `${c.name} · ${c.type} — click to select the column`
      const n = document.createElement('span')
      n.className = 'n'
      n.textContent = c.name
      const t = document.createElement('span')
      t.className = 't'
      t.textContent = c.type
      const grip = document.createElement('div')
      grip.className = 'yg-resize'
      grip.title = 'Drag to resize · double-click to fit'
      grip.addEventListener('pointerdown', (e) => this.startResize(e, i))
      grip.addEventListener('dblclick', (e) => {
        e.stopPropagation()
        this.autofit(i)
      })
      const sortBtn = document.createElement('span')
      const sorted = this.sort?.col === i
      sortBtn.className = sorted ? 'yg-sort on' : 'yg-sort'
      sortBtn.textContent = sorted ? (this.sort!.desc ? '▼' : '▲') : '⇅'
      sortBtn.title = sorted
        ? this.sort!.desc
          ? 'Sorted descending · click for the query order'
          : 'Sorted ascending · click for descending'
        : 'Sort ascending'
      sortBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        void this.toggleSort(i)
      })
      h.append(n, t, sortBtn, grip)
      this.header.appendChild(h)
    })
  }

  private startResize(e: PointerEvent, col: number) {
    e.preventDefault()
    e.stopPropagation()
    const grip = e.target as HTMLElement
    grip.classList.add('drag')
    // The drag follows the window, not the grip: it keeps going outside the header and past the grid.
    document.body.style.cursor = 'col-resize'
    const startX = e.clientX
    const startW = this.widths[col]
    let frame = 0
    const move = (ev: PointerEvent) => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        this.widths[col] = Math.max(MIN_COL, startW + ev.clientX - startX)
        this.layout()
      })
    }
    const up = () => {
      grip.classList.remove('drag')
      document.body.style.cursor = ''
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  /** Double-click on a column's edge: as wide as its header and the loaded values need (no 420px cap). */
  private autofit(col: number) {
    const ctx = document.createElement('canvas').getContext('2d')!
    ctx.font = CELL_FONT
    let w = this.headerWidth(this.columns[col])
    for (let r = 0; r < Math.min(this.rowCount, 2000); r++) {
      const v = this.data?.row(r)?.[col]
      if (v)
        w = Math.max(
          w,
          ctx.measureText(displayValue(v.length > 200 ? v.slice(0, 200) : v)).width + PAD * 2 + 2,
        )
    }
    this.widths[col] = Math.round(Math.min(Math.max(w, MIN_COL), 1200))
    this.layout()
  }

  private schedule() {
    cancelAnimationFrame(this.frame)
    this.frame = requestAnimationFrame(() => this.render())
  }

  private render() {
    const vp = this.viewport
    const top = vp.scrollTop
    const height = vp.clientHeight - HEADER
    const first = Math.max(0, Math.floor(top / ROW))
    const last = Math.min(this.totalRows, Math.ceil((top + height) / ROW) + 1)

    const left = vp.scrollLeft
    const c0 = this.colAt(left)
    const c1 = Math.min(this.columns.length, this.colAt(left + vp.clientWidth - GUTTER) + 1)
    const visibleCols = Math.max(0, c1 - c0)

    const needed = Math.max(0, last - first)
    while (this.rows.length < needed) this.rows.push(this.createRow())
    const sel = this.selectionRect()
    const staged = this.staged
    const lastRow = this.totalRows - 1
    const lastCol = this.columns.length - 1
    const wholeCols = !!sel && sel.r0 === 0 && sel.r1 === lastRow
    const wholeRows = !!sel && sel.c0 === 0 && sel.c1 === lastCol
    this.hcells.forEach((h, c) => {
      const inSel = !!sel && c >= sel.c0 && c <= sel.c1
      const cls = h.base + (inSel ? (wholeCols ? ' full' : ' in') : '')
      if (h.el.className !== cls) h.el.className = cls
    })
    if (this.corner) this.corner.className = 'yg-hcell corner' + (wholeCols && wholeRows ? ' full' : '')

    for (let k = 0; k < this.rows.length; k++) {
      const slot = this.rows[k]
      const r = first + k
      if (k >= needed) {
        slot.el.style.display = 'none'
        continue
      }
      const insert = r >= this.rowCount ? staged?.inserts[r - this.rowCount] : undefined
      let rowCls = r % 2 ? 'yg-row odd' : 'yg-row'
      if (insert) rowCls += ' inserted'
      else if (staged?.deletes.has(r)) rowCls += ' deleted'
      if (insert ? staged?.failedInsert() === r - this.rowCount : staged?.failedRow() === r)
        rowCls += ' failed'
      slot.el.style.display = ''
      slot.el.className = rowCls
      slot.el.style.transform = `translateY(${r * ROW}px)`
      slot.el.style.width = this.body.style.width
      slot.gutter.textContent = insert ? '+' : String(r + 1)
      const rowSel = !!sel && r >= sel.r0 && r <= sel.r1
      slot.gutter.className = 'yg-cell yg-gutter' + (rowSel ? (wholeRows ? ' full' : ' in') : '')
      const row = insert ? undefined : this.data?.row(r)

      while (slot.cells.length < visibleCols) {
        const cell = document.createElement('div')
        slot.el.insertBefore(cell, slot.gutter)
        slot.cells.push(cell)
      }
      for (let j = 0; j < slot.cells.length; j++) {
        const cell = slot.cells[j]
        const c = c0 + j
        if (j >= visibleCols) {
          cell.style.display = 'none'
          continue
        }
        cell.style.display = ''
        cell.style.left = `${GUTTER + this.offsets[c]}px`
        cell.style.width = `${this.widths[c]}px`

        let cls = NUMERIC.has(this.columns[c].type) ? 'yg-cell num' : 'yg-cell'
        let v: string | null | undefined
        let title = ''
        if (insert) {
          if (insert.has(c)) {
            v = insert.get(c)!
            cls += ' edited'
          } else {
            cls += ' default'
            cell.textContent = 'default'
          }
        } else if (staged?.isEdited(r, c)) {
          v = staged.value(r, c)!
          cls += ' edited'
          const was = staged.original(r, c)
          title = `was: ${was === null ? 'null' : was === undefined ? '…' : was.length > 200 ? was.slice(0, 200) + '…' : was}`
        } else {
          v = row ? row[c] : undefined
        }
        if (!cls.includes('default')) {
          if (v === null) {
            cls += ' null'
            cell.textContent = 'null'
          } else if (v === '') {
            cls += ' empty'
            cell.textContent = "''"
          } else {
            cell.textContent = v === undefined ? '' : displayValue(v)
          }
        }
        if (sel && r >= sel.r0 && r <= sel.r1 && c >= sel.c0 && c <= sel.c1) cls += ' sel'
        if (this.found.size && this.found.has(`${r}:${c}`)) {
          const cur = this.foundList[this.foundIndex]
          cls += cur && cur.r === r && cur.c === c ? ' found found-cur' : ' found'
        }
        if (this.focus && this.focus.r === r && this.focus.c === c) cls += ' active'
        cell.className = cls
        if (cell.title !== title) cell.title = title
      }
    }

    this.reportFocus()
  }

  /** The inspector follows the active cell; follow() ignores repeats, so per-frame calls are cheap. */
  private reportFocus() {
    const f = this.focus
    this.inspector.follow(
      f && this.data && f.r < this.rowCount
        ? { resultId: this.data.resultId, row: f.r, col: f.c, column: this.columns[f.c] }
        : null,
    )
  }

  private createRow() {
    const el = document.createElement('div')
    el.className = 'yg-row'
    const gutter = document.createElement('div')
    gutter.className = 'yg-cell yg-gutter'
    el.appendChild(gutter)
    this.body.appendChild(el)
    return { el, gutter, cells: [] as HTMLDivElement[] }
  }

  /** Column index containing x (content coordinates, gutter excluded). */
  private colAt(x: number): number {
    let lo = 0
    let hi = this.columns.length - 1
    if (hi < 0) return 0
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.offsets[mid] <= x) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  /**
   * Header and row numbers are sticky, so they're found in viewport coordinates (where they're drawn);
   * cells in content coordinates. Null for the scrollbars and the empty area past the last row.
   */
  private hitTest(e: MouseEvent): Hit | null {
    const vp = this.viewport
    const rect = vp.getBoundingClientRect()
    const vx = e.clientX - rect.left
    const vy = e.clientY - rect.top
    if (vx < 0 || vy < 0 || vx >= vp.clientWidth || vy >= vp.clientHeight || !this.columns.length) return null
    const c = vx < GUTTER ? -1 : this.colAt(vx + vp.scrollLeft - GUTTER)
    if (vy < HEADER) return { zone: c < 0 ? 'corner' : 'header', r: -1, c }
    const r = Math.floor((vy + vp.scrollTop - HEADER) / ROW)
    if (r >= this.totalRows) return null
    return { zone: c < 0 ? 'gutter' : 'cell', r, c }
  }

  /** The cell under the pointer while dragging, clamped to the grid (sticky parts count as the edge). */
  private cellUnder(e: MouseEvent): Cell {
    const vp = this.viewport
    const rect = vp.getBoundingClientRect()
    const x = Math.max(e.clientX - rect.left, GUTTER) + vp.scrollLeft - GUTTER
    const y = Math.max(e.clientY - rect.top, HEADER) + vp.scrollTop - HEADER
    return {
      r: Math.min(Math.max(Math.floor(y / ROW), 0), this.totalRows - 1),
      c: Math.min(this.colAt(x), this.columns.length - 1),
    }
  }

  /**
   * Whole rows / columns / everything are plain rectangles; the active cell (focus) goes to their
   * top-left so the inspector and Ctrl+arrows start somewhere sensible.
   */
  private select(hit: Hit, extend: boolean) {
    if (!this.totalRows) return
    const lastRow = this.totalRows - 1
    const lastCol = this.columns.length - 1
    const extending = extend && !!this.anchor
    switch (hit.zone) {
      case 'corner':
        return this.selectAll()
      case 'header':
        this.anchor = { r: lastRow, c: extending ? this.anchor!.c : hit.c }
        this.focus = { r: 0, c: hit.c }
        break
      case 'gutter':
        this.anchor = { r: extending ? this.anchor!.r : hit.r, c: lastCol }
        this.focus = { r: hit.r, c: 0 }
        break
      case 'cell':
        this.focus = { r: hit.r, c: hit.c }
        if (!extending) this.anchor = this.focus
        break
    }
    this.schedule()
  }

  private selectAll() {
    if (!this.totalRows) return
    this.anchor = { r: this.totalRows - 1, c: this.columns.length - 1 }
    this.focus = { r: 0, c: 0 }
    this.schedule()
  }

  /** Whether a right-click lands inside the selection (then "Copy as…" applies to all of it). */
  private covers(hit: Hit): boolean {
    const sel = this.selectionRect()
    if (!sel) return false
    const allRows = sel.r0 === 0 && sel.r1 === this.totalRows - 1
    const allCols = sel.c0 === 0 && sel.c1 === this.columns.length - 1
    switch (hit.zone) {
      case 'corner':
        return allRows && allCols
      case 'header':
        return allRows && hit.c >= sel.c0 && hit.c <= sel.c1
      case 'gutter':
        return allCols && hit.r >= sel.r0 && hit.r <= sel.r1
      default:
        return hit.r >= sel.r0 && hit.r <= sel.r1 && hit.c >= sel.c0 && hit.c <= sel.c1
    }
  }

  private onMouseDown(e: MouseEvent) {
    const target = e.target as HTMLElement
    if (
      target.classList.contains('yg-resize') ||
      target.classList.contains('yg-sort') ||
      target === this.editor
    )
      return
    const hit = this.hitTest(e)
    if (!hit) return
    this.commitEdit()
    this.viewport.focus()
    // Right-click keeps a selection it lands in (so "Copy as…" applies to it), else selects what it hit.
    if (e.button === 2) {
      if (!this.covers(hit)) this.select(hit, false)
      return
    }
    if (e.button !== 0) return
    e.preventDefault() // no text selection while dragging across headers / row numbers
    this.select(hit, e.shiftKey)
    if (hit.zone === 'corner' || !this.totalRows) return

    // Dragging extends along the axis that was clicked: columns from a header, rows from row numbers.
    const move = (ev: MouseEvent) => {
      const under = this.cellUnder(ev)
      if (hit.zone === 'header') this.focus = { r: 0, c: under.c }
      else if (hit.zone === 'gutter') this.focus = { r: under.r, c: 0 }
      else this.focus = under
      this.schedule()
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  private onDoubleClick(e: MouseEvent) {
    const hit = this.hitTest(e)
    if (hit?.zone === 'cell') this.startEdit(hit)
  }

  /** Excel's Shift+Space / Ctrl+Space: grow the selection to whole rows / whole columns. */
  private growSelection(axis: 'rows' | 'cols') {
    const sel = this.selectionRect()
    if (!sel || !this.focus) return
    const f = this.focus
    if (axis === 'rows') {
      this.anchor = { r: f.r === sel.r0 ? sel.r1 : sel.r0, c: this.columns.length - 1 }
      this.focus = { r: f.r, c: 0 }
    } else {
      this.anchor = { r: this.totalRows - 1, c: f.c === sel.c0 ? sel.c1 : sel.c0 }
      this.focus = { r: 0, c: f.c }
    }
    this.schedule()
  }

  private onKeyDown(e: KeyboardEvent) {
    if (!this.columns.length) return
    const ctrl = e.ctrlKey || e.metaKey
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key

    if (ctrl && key === 'c') return this.consume(e, () => this.copy())
    if (ctrl && key === 'f') return this.consume(e, () => this.openFind())
    if (key === 'F3' && this.foundList.length)
      return this.consume(e, () => this.stepFind(e.shiftKey ? -1 : 1))
    if (ctrl && key === 'z') return this.consume(e, () => this.staged?.undo())
    if (ctrl && key === 'd') return this.consume(e, () => this.setNull())
    if (e.altKey && key === 'Insert') return this.consume(e, () => this.addRow())
    if (key === 'Delete' && !ctrl) return this.consume(e, () => this.toggleDelete())
    if ((key === 'F2' || key === 'Enter') && !ctrl && !e.altKey && this.focus)
      return this.consume(e, () => this.startEdit(this.focus!))
    if (key === ' ' && e.shiftKey && !ctrl) return this.consume(e, () => this.growSelection('rows'))
    if (key === ' ' && ctrl && !e.shiftKey) return this.consume(e, () => this.growSelection('cols'))
    if (key === ' ' && !ctrl) {
      return this.consume(e, () => {
        if (!this.focus && this.totalRows) {
          this.anchor = this.focus = { r: 0, c: 0 }
          this.schedule()
        }
        this.inspector.show()
      })
    }
    if (ctrl && key === 'a') return this.consume(e, () => this.selectAll())
    // Typing a character starts editing with it (replacing the value), like a spreadsheet.
    if (e.key.length === 1 && !ctrl && !e.altKey && this.focus)
      return this.consume(e, () => this.startEdit(this.focus!, e.key))

    if (!this.totalRows) return
    const page = Math.max(1, Math.floor((this.viewport.clientHeight - HEADER) / ROW) - 1)
    const f = this.focus ?? { r: 0, c: 0 }
    const moves: Record<string, Cell> = {
      ArrowUp: { r: f.r - 1, c: f.c },
      ArrowDown: { r: f.r + 1, c: f.c },
      ArrowLeft: { r: f.r, c: f.c - 1 },
      ArrowRight: { r: f.r, c: f.c + 1 },
      PageUp: { r: f.r - page, c: f.c },
      PageDown: { r: f.r + page, c: f.c },
      Home: ctrl ? { r: 0, c: 0 } : { r: f.r, c: 0 },
      End: ctrl
        ? { r: this.totalRows - 1, c: this.columns.length - 1 }
        : { r: f.r, c: this.columns.length - 1 },
    }
    const next = moves[e.key]
    if (!next) return
    e.preventDefault()
    this.moveTo(next, e.shiftKey)
  }

  private consume(e: KeyboardEvent, action: () => void) {
    e.preventDefault()
    e.stopPropagation()
    action()
  }

  private moveTo(next: Cell, extend = false) {
    const clamped = {
      r: Math.min(Math.max(next.r, 0), this.totalRows - 1),
      c: Math.min(Math.max(next.c, 0), this.columns.length - 1),
    }
    this.focus = clamped
    if (!extend || !this.anchor) this.anchor = clamped
    this.scrollIntoView(clamped)
    this.schedule()
  }

  private scrollIntoView({ r, c }: Cell) {
    const vp = this.viewport
    const y = r * ROW
    const h = vp.clientHeight - HEADER
    if (y < vp.scrollTop) vp.scrollTop = y
    else if (y + ROW > vp.scrollTop + h) vp.scrollTop = y + ROW - h
    const x = this.offsets[c]
    const w = vp.clientWidth - GUTTER
    if (x < vp.scrollLeft) vp.scrollLeft = x
    else if (x + this.widths[c] > vp.scrollLeft + w) vp.scrollLeft = x + this.widths[c] - w
  }

  // ── Editing ──────────────────────────────────────────────────────────────

  /** Checks a column (and, for inserts/deletes, the row) can be edited; says why not otherwise. */
  private async canEdit(cols: number[], rowOp = false): Promise<boolean> {
    const block = this.editBlock()
    if (block) {
      this.edits.say(block, true)
      return false
    }
    if (!this.data) return false
    const info = await firstValueFrom(this.edits.editabilityOf(this.data.resultId))
    if (info.error) {
      this.edits.say(info.error, true)
      return false
    }
    if (rowOp && !info.rows.editable) {
      this.edits.say(info.rows.reason ?? 'Rows of this result can’t be added or deleted', true)
      return false
    }
    const blocked = cols.find((c) => !info.columns[c]?.editable)
    if (blocked !== undefined) {
      this.edits.say(
        `${this.columns[blocked].name}: ${info.columns[blocked]?.reason ?? 'not editable'}`,
        true,
      )
      return false
    }
    return true
  }

  private async startEdit(cell: Cell, typed?: string) {
    if (this.editing || !this.staged || !this.data) return
    const insertIndex = cell.r - this.rowCount
    const isInsert = insertIndex >= 0
    if (!isInsert && this.staged.deletes.has(cell.r))
      return this.edits.say('This row is marked for deletion', true)
    if (!(await this.canEdit([cell.c]))) return

    // Edit the real value: grid windows cut long values, so fetch the full one.
    let current: string | null
    let original: string | null
    if (isInsert) {
      current = this.staged.inserts[insertIndex]?.get(cell.c) ?? null
      original = null
    } else {
      const full = await firstValueFrom(this.socket.cell(this.data.resultId, cell.r, cell.c))
      if (full === undefined)
        return this.edits.say('This result is no longer available. Run the query again.', true)
      original = this.staged.original(cell.r, cell.c) ?? full
      current = this.staged.isEdited(cell.r, cell.c) ? this.staged.value(cell.r, cell.c)! : full
    }

    this.anchor = this.focus = cell
    this.scrollIntoView(cell)
    this.schedule()
    this.editing = { cell, original }
    const ed = this.editor
    const value = typed ?? current ?? ''
    ed.value = value
    ed.placeholder = current === null && typed === undefined ? 'null' : ''
    ed.style.left = `${GUTTER + this.offsets[cell.c]}px`
    ed.style.top = `${HEADER + cell.r * ROW}px`
    ed.style.width = `${Math.max(this.widths[cell.c], 160)}px`
    ed.rows = Math.min(8, value.split('\n').length)
    ed.hidden = false
    ed.focus()
    if (typed === undefined) ed.select()
    else ed.setSelectionRange(value.length, value.length)
    void this.openPicker(cell, current, typed !== undefined)
  }

  // ── Value picker ─────────────────────────────────────────────────────────

  /** Enum and foreign-key columns get a list of what may go in them under the editor. */
  private async openPicker(cell: Cell, current: string | null, typed: boolean) {
    if (!this.data) return
    const resultId = this.data.resultId
    const rel = (await firstValueFrom(this.relations.of(resultId)))[cell.c]
    if (!rel || (!rel.enum && !rel.references) || this.editing?.cell !== cell) return
    const res = await firstValueFrom(this.relations.values(resultId, cell.c))
    if (this.editing?.cell !== cell) return
    const fk = rel.references
    this.picker = {
      cell,
      all: res.values,
      items: res.values,
      search: res.truncated,
      current,
      highlight: res.values.findIndex((v) => v.value === current),
      title: fk
        ? `${tableSql(fk.table)}.${fk.column}${res.truncated ? ' · type to search' : ''}`
        : rel.enum!.type,
    }
    // Opened by typing a character: that's already a filter.
    if (typed) this.filterPicker()
    else this.renderPicker()
  }

  private filterPicker() {
    const p = this.picker
    if (!p || !this.data) return
    const q = this.editor.value.trim()
    if (p.search) {
      clearTimeout(p.timer)
      const resultId = this.data.resultId
      p.timer = setTimeout(async () => {
        const res = await firstValueFrom(this.relations.values(resultId, p.cell.c, q || undefined))
        if (this.picker !== p) return
        p.items = res.values
        p.highlight = q && p.items.length ? 0 : p.items.findIndex((v) => v.value === p.current)
        this.renderPicker()
      }, 200)
      return
    }
    p.items = rankValues(p.all, q)
    p.highlight = q && p.items.length ? 0 : p.items.findIndex((v) => v.value === p.current)
    this.renderPicker()
  }

  private renderPicker() {
    const p = this.picker
    const el = this.pickerEl
    if (!p) return
    el.textContent = ''
    const title = document.createElement('div')
    title.className = 'yg-pick-title'
    title.textContent = p.title
    el.appendChild(title)
    if (!p.items.length) {
      const empty = document.createElement('div')
      empty.className = 'yg-pick-empty'
      empty.textContent = 'No match · Enter keeps what you typed'
      el.appendChild(empty)
    }
    p.items.forEach((item, i) => {
      const row = document.createElement('div')
      row.className = 'yg-pick' + (i === p.highlight ? ' on' : '') + (item.value === p.current ? ' cur' : '')
      const v = document.createElement('span')
      v.className = 'v'
      v.textContent = item.value
      row.appendChild(v)
      if (item.label) {
        const l = document.createElement('span')
        l.className = 'l'
        l.textContent = item.label
        row.appendChild(l)
      }
      // mousedown, not click: the editor must not blur (blur commits what's typed).
      row.addEventListener('mousedown', (e) => {
        e.preventDefault()
        this.choose(i)
      })
      el.appendChild(row)
    })
    el.style.left = this.editor.style.left
    el.style.top = `${this.editor.offsetTop + this.editor.offsetHeight + 2}px`
    el.hidden = false
    ;(el.children[p.highlight + 1] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' })
  }

  private choose(i: number) {
    const p = this.picker
    if (!p?.items[i]) return
    this.editor.value = p.items[i].value
    this.commitEdit()
    this.viewport.focus()
  }

  private closePicker() {
    if (this.picker) clearTimeout(this.picker.timer)
    this.picker = null
    if (this.pickerEl) this.pickerEl.hidden = true
  }

  private onEditorKey(e: KeyboardEvent) {
    // Keys typed into the editor belong to it, not to the grid's shortcuts.
    e.stopPropagation()
    const cell = this.editing?.cell
    if (!cell) return
    const p = this.picker
    if (p && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && p.items.length) {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      p.highlight = Math.min(p.items.length - 1, Math.max(0, p.highlight + step))
      this.renderPicker()
      return
    }
    // Enter / Tab take the highlighted value, then commit as usual.
    if (p && p.highlight >= 0 && ((e.key === 'Enter' && !e.shiftKey && !e.altKey) || e.key === 'Tab'))
      this.editor.value = p.items[p.highlight].value
    if (e.key === 'Escape') {
      e.preventDefault()
      this.cancelEdit()
      this.viewport.focus()
    } else if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      this.commitEdit()
      this.viewport.focus()
      this.moveTo({ r: cell.r + 1, c: cell.c })
    } else if (e.key === 'Tab') {
      e.preventDefault()
      this.commitEdit()
      this.viewport.focus()
      this.moveTo({ r: cell.r, c: cell.c + (e.shiftKey ? -1 : 1) })
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
      e.preventDefault()
      this.commitEdit(null)
      this.viewport.focus()
    } else if (e.key === 'Enter') {
      // Shift+Enter: newline; grow up to 8 lines.
      queueMicrotask(() => (this.editor.rows = Math.min(8, this.editor.value.split('\n').length)))
    }
  }

  private commitEdit(forced?: null) {
    const editing = this.editing
    if (!editing || !this.staged) return
    this.editing = null
    this.editor.hidden = true
    this.closePicker()
    const value = forced === null ? null : this.editor.value
    const { cell, original } = editing
    const insertIndex = cell.r - this.rowCount
    if (insertIndex >= 0) this.staged.setInsertCell(insertIndex, cell.c, value)
    else this.staged.setCell(cell.r, cell.c, value, original)
  }

  private cancelEdit() {
    this.editing = null
    if (this.editor) this.editor.hidden = true
    this.closePicker()
  }

  /** Ctrl+D: NULL into every selected cell (all must be editable). */
  private async setNull() {
    const sel = this.selectionRect()
    if (!sel || !this.staged || !this.data) return
    const cols = Array.from({ length: sel.c1 - sel.c0 + 1 }, (_, i) => sel.c0 + i)
    if (!(await this.canEdit(cols))) return
    // Originals (full values) for the existing rows, fetched once.
    const lastExisting = Math.min(sel.r1, this.rowCount - 1)
    const full = lastExisting >= sel.r0 ? await firstValueFrom(this.data.range(sel.r0, lastExisting + 1)) : []
    for (let r = sel.r0; r <= sel.r1; r++) {
      if (r >= this.rowCount) {
        cols.forEach((c) => this.staged!.setInsertCell(r - this.rowCount, c, null))
      } else if (!this.staged.deletes.has(r)) {
        cols.forEach((c) =>
          this.staged!.setCell(r, c, null, this.staged!.original(r, c) ?? full[r - sel.r0][c]),
        )
      }
    }
  }

  /** Delete: marks the selected rows for deletion (again to unmark); new rows are just dropped. */
  private async toggleDelete() {
    const sel = this.selectionRect()
    if (!sel || !this.staged) return
    const existing: number[] = []
    const inserted: number[] = []
    for (let r = sel.r0; r <= sel.r1; r++) (r >= this.rowCount ? inserted : existing).push(r)
    if (inserted.length) this.staged.removeInserts(inserted.map((r) => r - this.rowCount))
    if (existing.length && (await this.canEdit([], true))) this.staged.toggleDeletes(existing)
  }

  /** Alt+Insert: a new row at the end, editing its first editable non-key column (keys usually default). */
  private async addRow() {
    if (!this.staged || !this.data || !(await this.canEdit([], true))) return
    const info = await firstValueFrom(this.edits.editabilityOf(this.data.resultId))
    this.staged.addRow()
    const r = this.totalRows - 1
    const pk = new Set(info.rows.primaryKey ?? [])
    const nonKey = info.columns.findIndex((x, i) => x.editable && !pk.has(i))
    const c = Math.max(0, nonKey >= 0 ? nonKey : info.columns.findIndex((x) => x.editable))
    this.layout()
    this.moveTo({ r, c })
    this.startEdit({ r, c })
  }

  // ── Sort ───────────────────────────────────────────────────────────────

  /** Header toggle: ascending → descending → the query's own order. The server reorders its buffer. */
  private async toggleSort(col: number) {
    if (!this.data) return
    if (this.staged?.count()) return this.edits.say('Apply or discard the staged edits before sorting', true)
    const next = this.sort?.col !== col ? { col, desc: false } : !this.sort.desc ? { col, desc: true } : null
    const res = await firstValueFrom(
      this.tools.sort(this.data.resultId, next?.col ?? null, next?.desc ?? false),
    )
    if ('error' in res) return this.edits.say(res.error, true)
    this.sort = next
    this.data.refresh()
    this.renderHeader()
    this.schedule()
    if (!this.findBar.hidden && this.findInput.value) this.runFind()
    if (next && res.capped)
      this.edits.say(
        'Sorted the rows that were loaded — the result was capped, so not the whole table',
        false,
      )
  }

  // ── Find in results ────────────────────────────────────────────────────

  private openFind() {
    this.findBar.hidden = false
    const sel = this.selectionRect()
    // A single selected cell's value is a handy default search.
    if (!this.findInput.value && sel && sel.r0 === sel.r1 && sel.c0 === sel.c1) {
      const v = this.data?.row(sel.r0)?.[sel.c0]
      if (v && v.length < 100) this.findInput.value = v
    }
    this.findInput.focus()
    this.findInput.select()
    if (this.findInput.value) this.runFind()
  }

  private closeFind() {
    this.findBar.hidden = true
    this.clearFound()
    this.schedule()
    this.viewport.focus()
  }

  private clearFound() {
    this.found = new Set()
    this.foundList = []
    this.foundIndex = -1
    this.foundTotal = 0
    if (this.findCount) this.findCount.textContent = ''
  }

  /** Searches the whole buffered result (full values, case-insensitive) on the server. */
  private async runFind() {
    const text = this.findInput.value
    if (!this.data || !text) {
      this.clearFound()
      this.schedule()
      return
    }
    const res = await firstValueFrom(this.tools.find(this.data.resultId, text))
    if (this.findInput.value !== text) return
    this.foundList = res.matches.map(([r, c]) => ({ r, c }))
    this.found = new Set(res.matches.map(([r, c]) => `${r}:${c}`))
    this.foundTotal = res.total
    // Start at the first match at or after the cursor.
    const f = this.focus ?? { r: 0, c: 0 }
    const at = this.foundList.findIndex((m) => m.r > f.r || (m.r === f.r && m.c >= f.c))
    this.foundIndex = this.foundList.length ? Math.max(0, at) : -1
    this.showFound()
  }

  private stepFind(dir: number) {
    if (!this.foundList.length) return
    this.foundIndex = (this.foundIndex + dir + this.foundList.length) % this.foundList.length
    this.showFound()
  }

  private showFound() {
    const n = this.foundList.length
    this.findCount.textContent = n
      ? `${this.foundIndex + 1} / ${this.foundTotal.toLocaleString()}${this.foundTotal > n ? '+' : ''}`
      : 'no match'
    const cur = this.foundList[this.foundIndex]
    if (cur) {
      this.anchor = this.focus = cur
      this.scrollIntoView(cur)
    }
    this.schedule()
  }

  private onFindKey(e: KeyboardEvent) {
    e.stopPropagation()
    if (e.key === 'Enter' || e.key === 'F3') {
      e.preventDefault()
      this.stepFind(e.shiftKey ? -1 : 1)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      this.closeFind()
    }
  }

  // ── Paste ──────────────────────────────────────────────────────────────

  /**
   * Excel-style paste as staged edits: the block lands at the selection's top-left, overwriting cells;
   * rows past the end become new rows. One value pasted into a bigger selection fills it. A first row
   * that repeats the column names is skipped. Empty fields become NULL. One Ctrl+Z undoes the paste.
   */
  private async paste(text: string) {
    if (!this.staged || !this.data || !this.columns.length) return
    const sel = this.selectionRect()
    if (!sel) return this.edits.say('Select the cell to paste into first', true)
    let rows = parseTsv(text)
    if (!rows.length) return
    const width = Math.max(...rows.map((r) => r.length))
    const names = this.columns.slice(sel.c0, sel.c0 + width).map((c) => c.name.toLowerCase())
    if (
      rows.length > 1 &&
      rows[0].length === names.length &&
      rows[0].every((v, i) => v.trim().toLowerCase() === names[i])
    )
      rows = rows.slice(1)

    const fill = rows.length === 1 && rows[0].length === 1 && (sel.r1 > sel.r0 || sel.c1 > sel.c0)
    const block = fill
      ? Array.from(
          { length: sel.r1 - sel.r0 + 1 },
          () => Array(sel.c1 - sel.c0 + 1).fill(rows[0][0]) as string[],
        )
      : rows
    const lastCol = this.columns.length - 1
    const blockWidth = Math.max(...block.map((r) => r.length))
    const cols = Array.from({ length: Math.min(blockWidth, lastCol - sel.c0 + 1) }, (_, i) => sel.c0 + i)
    const cut = blockWidth - cols.length
    if (block.length * cols.length > 50_000)
      return this.edits.say('That is more than 50,000 cells — too much to stage', true)
    if (!(await this.canEdit(cols))) return

    const r0 = sel.r0
    const rEnd = r0 + block.length - 1
    const newRows = Math.max(0, rEnd - (this.totalRows - 1))
    if (newRows && !(await this.canEdit([], true))) return
    const lastExisting = Math.min(rEnd, this.rowCount - 1)
    const loaded = lastExisting >= r0 ? await firstValueFrom(this.data.range(r0, lastExisting + 1)) : []

    let cells = 0
    const staged = this.staged
    staged.batch(() => {
      block.forEach((fields, i) => {
        const r = r0 + i
        cols.forEach((c, j) => {
          if (j >= fields.length) return
          const value = fields[j] === '' ? null : fields[j]
          if (r < this.rowCount) {
            if (staged.deletes.has(r)) return
            const original = staged.original(r, c) ?? loaded[i]?.[c] ?? null
            const current = staged.isEdited(r, c) ? staged.value(r, c)! : (loaded[i]?.[c] ?? null)
            if (value === current) return
            staged.setCell(r, c, value, original)
          } else {
            const index = r - this.rowCount
            while (staged.inserts.length <= index) staged.addRow()
            staged.setInsertCell(index, c, value)
          }
          cells++
        })
      })
    })
    this.layout()
    this.edits.say(
      `Pasted ${cells.toLocaleString()} ${cells === 1 ? 'cell' : 'cells'}${newRows ? ` incl. ${newRows} new ${newRows === 1 ? 'row' : 'rows'}` : ''}` +
        `${cut ? ` · ${cut} extra ${cut === 1 ? 'column' : 'columns'} didn't fit` : ''} — staged, review before applying`,
      false,
    )
  }

  /** Current range selection, for export scope. */
  selection() {
    return this.selectionRect()
  }

  /** The one column the selection is in (what a right-click follows), or null. */
  selectionColumn(): number | null {
    const s = this.selectionRect()
    return s && s.c0 === s.c1 && s.r0 < this.rowCount ? s.c0 : null
  }

  /** Values of the selected (existing) rows in a column, at most 1000 — for "go to … IN (…)". */
  async selectedValues(col: number): Promise<(string | null)[]> {
    const s = this.selectionRect()
    if (!s || !this.data) return []
    const last = Math.min(s.r1, this.rowCount - 1, s.r0 + 999)
    if (last < s.r0) return []
    const rows = await firstValueFrom(this.data.range(s.r0, last + 1))
    return rows.map((r) => r[col])
  }

  /** "Filter by selection": one column with its selected values, or one row across several columns. */
  async filterCells(): Promise<{ col: number; values: (string | null)[] }[] | null> {
    const s = this.selectionRect()
    if (!s || !this.data || s.r0 >= this.rowCount) return null
    if (s.c0 === s.c1) return [{ col: s.c0, values: await this.selectedValues(s.c0) }]
    if (s.r0 !== s.r1) return null
    const [row] = await firstValueFrom(this.data.range(s.r0, s.r0 + 1))
    if (!row) return null
    return Array.from({ length: s.c1 - s.c0 + 1 }, (_, i) => ({ col: s.c0 + i, values: [row[s.c0 + i]] }))
  }

  /** Selected rows (existing ones), and the value of the first, as loaded — for menu labels. */
  selectionPreview(col: number): { rows: number; first: string | null | undefined } {
    const s = this.selectionRect()
    if (!s) return { rows: 0, first: undefined }
    const rows = Math.max(0, Math.min(s.r1, this.rowCount - 1) - s.r0 + 1)
    return { rows, first: this.data?.row(s.r0)?.[col] }
  }

  private selectionRect() {
    if (!this.anchor || !this.focus) return null
    return {
      r0: Math.min(this.anchor.r, this.focus.r),
      r1: Math.max(this.anchor.r, this.focus.r),
      c0: Math.min(this.anchor.c, this.focus.c),
      c1: Math.max(this.anchor.c, this.focus.c),
    }
  }

  /** TSV, which pastes straight into Excel. NULL becomes an empty field. Copies what you see, staged edits included. */
  private copy() {
    const sel = this.selectionRect()
    if (!sel || !this.data) return
    const staged = this.staged
    const lastExisting = Math.min(sel.r1, this.rowCount - 1)
    const fetch = lastExisting >= sel.r0 ? this.data.range(sel.r0, lastExisting + 1) : null
    const finish = (rows: Row[]) => {
      const lines: (string | null)[][] = rows.map((row, i) =>
        row.map((v, c) => (staged?.isEdited(sel.r0 + i, c) ? staged.value(sel.r0 + i, c)! : v)),
      )
      for (let r = Math.max(sel.r0, this.rowCount); r <= sel.r1; r++) {
        const insert = staged?.inserts[r - this.rowCount]
        lines.push(this.columns.map((_, c) => insert?.get(c) ?? null))
      }
      const tsv = lines
        .map((row) =>
          row
            .slice(sel.c0, sel.c1 + 1)
            .map((v) => (v == null ? '' : /[\t\n\r"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v))
            .join('\t'),
        )
        .join('\r\n')
      navigator.clipboard.writeText(tsv)
    }
    if (fetch) fetch.subscribe(finish)
    else finish([])
  }
}

/** Exact value first, then values starting with q, then anything containing it (value or label). */
function rankValues(all: PickValue[], q: string): PickValue[] {
  if (!q) return all
  const needle = q.toLowerCase()
  const score = (v: PickValue) => {
    const value = v.value.toLowerCase()
    if (value === needle) return 0
    if (value.startsWith(needle)) return 1
    if (v.label?.toLowerCase().startsWith(needle)) return 2
    if (value.includes(needle) || v.label?.toLowerCase().includes(needle)) return 3
    return 9
  }
  return all
    .map((v, i) => ({ v, i, s: score(v) }))
    .filter((x) => x.s < 9)
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((x) => x.v)
}
