import { HttpClient } from '@angular/common/http'
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core'
import { toObservable, toSignal } from '@angular/core/rxjs-interop'
import { catchError, map, of, startWith, switchMap } from 'rxjs'
import { Icon } from '../ui/icon'
import { EditorTab, ResultView } from '../workspace/workspace'
import {
  buildSeries,
  ChartKind,
  ChartSpec,
  ColumnKind,
  compact,
  kindOf,
  MAX_SERIES,
  niceTicks,
  reconcile,
  Series,
  timeTicks,
} from './chart'

const MARGIN = { top: 10, right: 14, bottom: 24 }
const BAR_MAX = 24
const GAP = 2
const LABEL_PX = 6.6

interface Tick {
  at: number
  text: string
}

/**
 * Bar or line chart of the active result, beside the grid (which is its table view). Pulls just the
 * chosen columns of the buffered rows in one request; rows sharing an x are summed.
 */
@Component({
  selector: 'y-quick-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: { class: 'flex min-h-0 flex-col bg-raised' },
  template: `
    @let s = spec();
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-1.5 text-[12px]">
      @if (s) {
        <label class="flex items-center gap-1.5 text-muted">
          X
          <select class="pick" [value]="s.x" (change)="setX(+val($event))">
            @for (c of result().columns; track $index) {
              <option [value]="$index" [selected]="$index === s.x">{{ c.name }}</option>
            }
          </select>
        </label>
        <div class="flex min-w-0 flex-wrap items-center gap-1">
          <span class="text-muted">Y</span>
          @for (i of numberColumns(); track i) {
            <button
              class="ychip"
              [class.on]="s.ys.includes(i)"
              [attr.aria-pressed]="s.ys.includes(i)"
              [disabled]="i === s.x || (!s.ys.includes(i) && s.ys.length >= maxSeries)"
              (click)="toggleY(i)"
            >
              @if (s.ys.includes(i)) {
                <span class="swatch" [style.background]="color(s.ys.indexOf(i))"></span>
              }
              {{ result().columns[i].name }}
            </button>
          }
        </div>
        <span class="flex-1"></span>
        <div class="seg-group" role="radiogroup" aria-label="Chart type">
          @for (k of kinds; track k) {
            <button
              role="radio"
              class="seg"
              [class.seg-on]="s.kind === k"
              [attr.aria-checked]="s.kind === k"
              (click)="setKind(k)"
            >
              {{ k === 'line' ? 'Line' : 'Bar' }}
            </button>
          }
        </div>
      } @else {
        <span class="flex-1 text-muted">Nothing to plot — a chart needs a number column.</span>
      }
      <button
        class="grid size-6 place-items-center rounded text-muted hover:bg-hover"
        title="Close chart"
        (click)="tab().chart.set(null)"
      >
        <y-icon name="x" [size]="13" />
      </button>
    </div>

    <div #plot class="relative min-h-0 flex-1" (pointerleave)="hover.set(null)">
      @if (!result().done) {
        <p class="p-3 text-[12px] text-faint">Waiting for all rows…</p>
      } @else if (data()?.error; as error) {
        <p class="p-3 text-[12px] text-danger">{{ error }}</p>
      } @else if (geometry(); as g) {
        @if (g.legend.length > 1) {
          <div class="absolute top-1 left-3 flex flex-wrap gap-x-3 text-[11.5px] text-muted">
            @for (l of g.legend; track l.name) {
              <span class="flex items-center gap-1.5"
                ><span class="swatch" [style.background]="l.color"></span>{{ l.name }}</span
              >
            }
          </div>
        }
        <svg
          class="absolute inset-0"
          [attr.width]="g.width"
          [attr.height]="g.height"
          (pointermove)="onMove($event, g)"
          role="img"
          [attr.aria-label]="g.title"
        >
          @for (t of g.yTicks; track t.at) {
            <line
              class="grid"
              [attr.x1]="g.left"
              [attr.x2]="g.width - margin.right"
              [attr.y1]="t.at"
              [attr.y2]="t.at"
            />
            <text
              class="tick"
              [attr.x]="g.left - 6"
              [attr.y]="t.at"
              text-anchor="end"
              dominant-baseline="middle"
            >
              {{ t.text }}
            </text>
          }
          @for (t of g.xTicks; track $index) {
            <text class="tick" [attr.x]="t.at" [attr.y]="g.height - 8" text-anchor="middle">
              {{ t.text }}
            </text>
          }
          @if (g.hoverBand; as hb) {
            <rect
              class="band"
              [attr.x]="hb.x"
              [attr.y]="g.top"
              [attr.width]="hb.width"
              [attr.height]="g.bottom - g.top"
            />
          }
          <line
            class="axis"
            [attr.x1]="g.left"
            [attr.x2]="g.width - margin.right"
            [attr.y1]="g.zero"
            [attr.y2]="g.zero"
          />
          @for (b of g.bars; track $index) {
            <path [attr.d]="b.d" [attr.fill]="b.color" />
          }
          @for (l of g.lines; track $index) {
            <path class="line" [attr.d]="l.d" [attr.stroke]="l.color" />
          }
          @for (d of g.dots; track $index) {
            <circle [attr.cx]="d.x" [attr.cy]="d.y" r="4" [attr.fill]="d.color" class="dot" />
          }
          @if (g.crosshair !== null) {
            <line
              class="crosshair"
              [attr.x1]="g.crosshair"
              [attr.x2]="g.crosshair"
              [attr.y1]="g.top"
              [attr.y2]="g.bottom"
            />
          }
          @for (d of g.hoverDots; track $index) {
            <circle [attr.cx]="d.x" [attr.cy]="d.y" r="4" [attr.fill]="d.color" class="dot" />
          }
        </svg>
        @if (g.tooltip; as tip) {
          <div class="tooltip" [style.left.px]="tip.left" [style.top.px]="tip.top" [class.flip]="tip.flip">
            <div class="mb-1 font-medium text-fg">{{ tip.label }}</div>
            @for (r of tip.rows; track r.name) {
              <div class="flex items-center gap-2">
                <span class="swatch" [style.background]="r.color"></span>
                <span class="min-w-0 flex-1 truncate text-muted">{{ r.name }}</span>
                <span class="tabular-nums text-fg">{{ r.value }}</span>
              </div>
            }
          </div>
        }
      } @else if (data() && !data()?.error) {
        <p class="p-3 text-[12px] text-faint">No values to plot.</p>
      }
    </div>
    @if (note(); as n) {
      <div class="border-t border-line px-3 py-1 text-[11.5px] text-faint">{{ n }}</div>
    }
  `,
  styles: `
    :host {
      --series-1: #2a78d6;
      --series-2: #eb6834;
      --series-3: #1baf7a;
      --series-4: #eda100;
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --series-1: #3987e5;
        --series-2: #d95926;
        --series-3: #199e70;
        --series-4: #c98500;
      }
    }
    .pick {
      height: 24px;
      max-width: 160px;
      padding: 0 4px;
      border-radius: 4px;
      border: 1px solid var(--border-strong);
      background: var(--bg);
      color: var(--fg);
    }
    .ychip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 1px 7px;
      border-radius: 4px;
      border: 1px solid var(--border);
      color: var(--fg-muted);
    }
    .ychip.on {
      border-color: var(--border-strong);
      color: var(--fg);
    }
    .ychip:disabled {
      opacity: 0.45;
    }
    .swatch {
      width: 8px;
      height: 8px;
      border-radius: 2px;
      flex-shrink: 0;
    }
    .seg-group {
      display: flex;
      padding: 2px;
      border: 1px solid var(--border);
      border-radius: 4px;
    }
    .seg {
      padding: 0 8px;
      border-radius: 3px;
      color: var(--fg-muted);
    }
    .seg-on {
      background: var(--bg-selected);
      color: var(--fg);
    }
    .grid {
      stroke: var(--border);
      stroke-width: 1;
      shape-rendering: crispEdges;
    }
    .axis {
      stroke: var(--border-strong);
      stroke-width: 1;
      shape-rendering: crispEdges;
    }
    .tick {
      font-size: 11px;
      fill: var(--fg-faint);
      font-variant-numeric: tabular-nums;
    }
    .line {
      fill: none;
      stroke-width: 2;
      stroke-linejoin: round;
      stroke-linecap: round;
    }
    .dot {
      stroke: var(--bg-raised);
      stroke-width: 2;
    }
    .crosshair {
      stroke: var(--border-strong);
      stroke-width: 1;
    }
    .band {
      fill: var(--bg-hover);
    }
    .tooltip {
      position: absolute;
      z-index: 2;
      min-width: 140px;
      max-width: 280px;
      padding: 6px 8px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--bg-raised);
      box-shadow: 0 4px 14px rgb(0 0 0 / 0.12);
      font-size: 11.5px;
      pointer-events: none;
      transform: translate(12px, -50%);
    }
    .tooltip.flip {
      transform: translate(calc(-100% - 12px), -50%);
    }
  `,
})
export class QuickChart {
  readonly tab = input.required<EditorTab>()
  readonly result = input.required<ResultView>()

  private readonly http = inject(HttpClient)
  private readonly plotEl = viewChild.required<ElementRef<HTMLElement>>('plot')
  private readonly size = signal({ width: 0, height: 0 })
  protected readonly hover = signal<number | null>(null)
  protected readonly margin = MARGIN
  protected readonly maxSeries = MAX_SERIES
  protected readonly kinds: ChartKind[] = ['line', 'bar']

  /** The tab's chart choice, carried over to a new result by column name. */
  protected readonly spec = computed(() => {
    const state = this.tab().chart()
    const columns = this.result().columns
    return state ? reconcile(state.spec, columns, state.columns) : null
  })
  protected readonly numberColumns = computed(() =>
    this.result().columns.flatMap((c, i) => (kindOf(c.type) === 'number' ? [i] : [])),
  )
  private readonly xKind = computed<ColumnKind>(() => {
    const s = this.spec()
    return s ? kindOf(this.result().columns[s.x].type) : 'text'
  })

  protected readonly data = toSignal(
    toObservable(
      computed(
        () => {
          const r = this.result()
          const s = this.spec()
          return { id: r.resultId, done: r.done, version: r.version, cols: s ? [s.x, ...s.ys] : null }
        },
        { equal: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
      ),
    ).pipe(
      switchMap(({ id, done, cols }) =>
        !done || !cols
          ? of(null)
          : this.http
              .post<{ columns: (string | null)[][] }>(`/api/results/${id}/columns`, { columns: cols })
              .pipe(
                map((r) => ({ columns: r.columns, error: null as string | null })),
                catchError(() =>
                  of({
                    columns: [] as (string | null)[][],
                    error: 'Could not read the result (it may be gone).',
                  }),
                ),
                startWith(null),
              ),
      ),
    ),
  )

  private readonly series = computed((): Series | null => {
    const d = this.data()
    if (!d || d.error || !d.columns.length) return null
    const [xs, ...ys] = d.columns
    return buildSeries(this.xKind(), xs, ys)
  })

  protected readonly note = computed(() => {
    const s = this.series()
    const r = this.result()
    const parts: string[] = []
    if (s?.summed) parts.push('rows sharing an x value are summed')
    if (s?.truncated) parts.push(`first ${s.points.length} categories`)
    else if (s?.skipped) parts.push(`${s.skipped.toLocaleString()} rows without an x value left out`)
    if (r.capped) parts.push(`first ${r.rowCount.toLocaleString()} rows only (result capped)`)
    return parts.length ? parts.join(' · ').replace(/^./, (c) => c.toUpperCase()) : null
  })

  protected readonly geometry = computed(() => {
    const s = this.series()
    const spec = this.spec()
    const { width, height } = this.size()
    if (!s || !spec || !s.points.length || width < 120 || height < 80) return null
    const cols = this.result().columns
    const names = spec.ys.map((i) => cols[i].name)
    const colors = spec.ys.map((_, i) => this.color(i))
    const pts = s.points
    const bar = spec.kind === 'bar'
    const xKind = this.xKind()
    const categorical = bar || xKind === 'text'

    // y: round ticks; bars always start at zero.
    const values = pts.flatMap((p) => p.ys.filter((v): v is number => v !== null))
    if (!values.length) return null
    let lo = Math.min(...values)
    let hi = Math.max(...values)
    if (bar) {
      lo = Math.min(lo, 0)
      hi = Math.max(hi, 0)
    }
    const ticks = niceTicks(lo, hi, Math.max(2, Math.min(6, Math.floor(height / 50))))
    const [y0, y1] = [ticks[0], ticks.at(-1)!]
    const yLabels = ticks.map(compact)
    const left = Math.max(...yLabels.map((t) => t.length)) * LABEL_PX + 14
    const top = MARGIN.top + (spec.ys.length > 1 ? 18 : 0)
    const bottom = height - MARGIN.bottom
    const right = width - MARGIN.right
    const yAt = (v: number) => bottom - ((v - y0) / (y1 - y0 || 1)) * (bottom - top)

    // x: bands for categories (and every bar chart), a linear scale for time and numbers.
    const n = pts.length
    const band = (right - left) / n
    const xMin = pts[0].x
    const xMax = pts[n - 1].x
    const xAt = (i: number) =>
      categorical ? left + band * (i + 0.5) : left + ((pts[i].x - xMin) / (xMax - xMin || 1)) * (right - left)

    let xTicks: Tick[]
    if (categorical) {
      const maxChars = 14
      const labelW = Math.min(maxChars, Math.max(...pts.map((p) => p.label.length))) * LABEL_PX + 10
      const every = Math.max(1, Math.ceil(labelW / band))
      xTicks = pts.flatMap((p, i) =>
        i % every
          ? []
          : [
              {
                at: xAt(i),
                text: p.label.length > maxChars ? p.label.slice(0, maxChars - 1) + '…' : p.label,
              },
            ],
      )
    } else if (xKind === 'time') {
      const t = timeTicks(xMin, xMax, Math.max(2, Math.floor((right - left) / 110)))
      xTicks = t.ticks.map((v) => ({
        at: left + ((v - xMin) / (xMax - xMin || 1)) * (right - left),
        text: t.format(v),
      }))
    } else {
      xTicks = niceTicks(xMin, xMax, Math.max(2, Math.floor((right - left) / 80)))
        .filter((v) => v >= xMin && v <= xMax)
        .map((v) => ({ at: left + ((v - xMin) / (xMax - xMin || 1)) * (right - left), text: compact(v) }))
    }

    const zero = yAt(bar ? 0 : Math.max(y0, Math.min(0, y1)))
    const bars: { d: string; color: string }[] = []
    const lines: { d: string; color: string }[] = []
    const dots: { x: number; y: number; color: string }[] = []
    if (bar) {
      const k = spec.ys.length
      const w = Math.max(1, Math.min(BAR_MAX, (band * 0.8 - GAP * (k - 1)) / k))
      const group = w * k + GAP * (k - 1)
      pts.forEach((p, i) =>
        p.ys.forEach((v, si) => {
          if (v === null || v === 0) return
          const x = xAt(i) - group / 2 + si * (w + GAP)
          bars.push({ d: barPath(x, w, yAt(0), yAt(v)), color: colors[si] })
        }),
      )
    } else {
      spec.ys.forEach((_, si) => {
        let d = ''
        let pen = false
        pts.forEach((p, i) => {
          const v = p.ys[si]
          if (v === null) return void (pen = false)
          d += `${pen ? 'L' : 'M'}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`
          pen = true
        })
        lines.push({ d, color: colors[si] })
        // A lone point (or very few) would be invisible as a line.
        if (n <= 2 || n * 6 < right - left)
          if (n <= 24)
            pts.forEach(
              (p, i) => p.ys[si] !== null && dots.push({ x: xAt(i), y: yAt(p.ys[si]!), color: colors[si] }),
            )
      })
    }

    // Hover: the nearest point by x.
    const h = this.hover()
    const at = h === null ? null : Math.max(0, Math.min(n - 1, h))
    let tooltip = null
    let crosshair: number | null = null
    let hoverBand = null
    const hoverDots: { x: number; y: number; color: string }[] = []
    if (at !== null) {
      const p = pts[at]
      const x = xAt(at)
      if (categorical) hoverBand = { x: left + band * at, width: band }
      if (!bar) {
        crosshair = x
        p.ys.forEach((v, si) => v !== null && hoverDots.push({ x, y: yAt(v), color: colors[si] }))
      }
      const ys = p.ys.filter((v): v is number => v !== null)
      tooltip = {
        left: x,
        top: ys.length ? yAt(Math.max(...ys)) : (top + bottom) / 2,
        flip: x > width * 0.6,
        label: p.label,
        rows: p.ys.map((v, si) => ({
          name: names[si],
          color: colors[si],
          value: v === null ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: 4 }),
        })),
      }
    }

    return {
      width,
      height,
      left,
      top,
      bottom,
      zero,
      xs: pts.map((_, i) => xAt(i)),
      title: `${spec.kind === 'bar' ? 'Bar' : 'Line'} chart of ${names.join(', ')} by ${cols[spec.x].name}`,
      legend: names.map((name, i) => ({ name, color: colors[i] })),
      yTicks: ticks.map((v, i) => ({ at: yAt(v), text: yLabels[i] })),
      xTicks,
      bars,
      lines,
      dots,
      crosshair,
      hoverBand,
      hoverDots,
      tooltip,
    }
  })

  constructor() {
    const observer = new ResizeObserver(([entry]) =>
      this.size.set({ width: entry.contentRect.width, height: entry.contentRect.height }),
    )
    afterNextRender(() => observer.observe(this.plotEl().nativeElement))
    inject(DestroyRef).onDestroy(() => observer.disconnect())
  }

  protected color(i: number) {
    return `var(--series-${i + 1})`
  }

  protected val(e: Event) {
    return (e.target as HTMLSelectElement).value
  }

  private update(patch: Partial<ChartSpec>) {
    const s = this.spec()
    if (s) this.tab().chart.set({ spec: { ...s, ...patch }, columns: this.result().columns })
  }

  protected setX(x: number) {
    const s = this.spec()!
    const kind = kindOf(this.result().columns[x].type)
    this.update({ x, ys: s.ys.filter((i) => i !== x), kind: kind === 'text' ? 'bar' : s.kind })
  }

  protected toggleY(i: number) {
    const ys = this.spec()!.ys
    if (ys.includes(i)) {
      if (ys.length > 1) this.update({ ys: ys.filter((y) => y !== i) })
    } else if (ys.length < MAX_SERIES) this.update({ ys: [...ys, i] })
  }

  protected setKind(kind: ChartKind) {
    this.update({ kind })
  }

  protected onMove(e: PointerEvent, g: { xs: number[] }) {
    const x = e.offsetX
    let best = 0
    for (let i = 1; i < g.xs.length; i++) if (Math.abs(g.xs[i] - x) < Math.abs(g.xs[best] - x)) best = i
    this.hover.set(best)
  }
}

/** A bar from the baseline to the value: 4px rounded at the data end, square at the baseline. */
function barPath(x: number, w: number, base: number, end: number): string {
  const up = end < base
  const h = Math.abs(base - end)
  const r = Math.min(4, w / 2, h)
  const f = (n: number) => n.toFixed(1)
  if (up)
    return `M${f(x)},${f(base)}V${f(end + r)}Q${f(x)},${f(end)} ${f(x + r)},${f(end)}H${f(x + w - r)}Q${f(x + w)},${f(end)} ${f(x + w)},${f(end + r)}V${f(base)}Z`
  return `M${f(x)},${f(base)}V${f(end - r)}Q${f(x)},${f(end)} ${f(x + r)},${f(end)}H${f(x + w - r)}Q${f(x + w)},${f(end)} ${f(x + w)},${f(end - r)}V${f(base)}Z`
}
