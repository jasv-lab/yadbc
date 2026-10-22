import { Column } from '../core/protocol'

/**
 * The quick chart's model: which columns can be what, sensible defaults, points from raw column text,
 * and axis ticks. Pure — the view only draws what this returns.
 */

export type ColumnKind = 'number' | 'time' | 'text'
export type ChartKind = 'line' | 'bar'

export interface ChartSpec {
  x: number
  ys: number[]
  kind: ChartKind
}

export interface Point {
  /** The x value as text (category label, or the original timestamp). */
  label: string
  /** Position: epoch ms for time, the number for numbers, the index for categories. */
  x: number
  ys: (number | null)[]
}

export interface Series {
  points: Point[]
  /** Several rows shared an x value; their y values were summed. */
  summed: boolean
  /** Rows left out: no x value, or past the category cap. */
  skipped: number
  /** More categories than a bar chart can show; the first MAX_BARS are kept. */
  truncated: boolean
}

/** Four validated categorical slots; more series than that stop being readable here anyway. */
export const MAX_SERIES = 4
export const MAX_BARS = 60

const NUMBER = new Set(['int2', 'int4', 'int8', 'numeric', 'float4', 'float8'])
const TIME = new Set(['date', 'timestamp', 'timestamptz'])

export function kindOf(type: string): ColumnKind {
  return NUMBER.has(type) ? 'number' : TIME.has(type) ? 'time' : 'text'
}

/**
 * Time on x if there is a time column, else the first text column (categories), else the first number
 * of several; every other number is a series. Null when nothing is plottable.
 */
export function defaultSpec(columns: Column[]): ChartSpec | null {
  const kinds = columns.map((c) => kindOf(c.type))
  const numbers = kinds.flatMap((k, i) => (k === 'number' ? [i] : []))
  let x = kinds.indexOf('time')
  if (x < 0) x = kinds.indexOf('text')
  if (x < 0 && numbers.length >= 2) x = numbers[0]
  if (x < 0) return null
  const ys = numbers.filter((i) => i !== x).slice(0, MAX_SERIES)
  if (!ys.length) return null
  return { x, ys, kind: kinds[x] === 'text' ? 'bar' : 'line' }
}

/** Keeps what still fits the new columns (a re-run with other parameters keeps the chart). */
export function reconcile(spec: ChartSpec | null, columns: Column[], previous: Column[]): ChartSpec | null {
  if (!spec) return defaultSpec(columns)
  const at = (i: number) => columns.findIndex((c) => c.name === previous[i]?.name)
  const x = at(spec.x)
  const ys = spec.ys.map(at).filter((i) => i >= 0 && i !== x && kindOf(columns[i].type) === 'number')
  return x >= 0 && ys.length ? { ...spec, x, ys } : defaultSpec(columns)
}

/** Postgres timestamp text → epoch ms (`2026-10-22 19:28:26.29+02`, `2026-10-22`); NaN when it isn't one. */
export function parseTime(text: string): number {
  let s = text.trim().replace(' ', 'T')
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T00:00'
  s = s.replace(/([+-]\d{2})$/, '$1:00')
  return Date.parse(s)
}

export function buildSeries(xKind: ColumnKind, xs: (string | null)[], ys: (string | null)[][]): Series {
  const byLabel = new Map<string, Point>()
  let skipped = 0
  let summed = false
  let truncated = false
  xs.forEach((label, row) => {
    if (label === null) return void skipped++
    let point = byLabel.get(label)
    if (!point) {
      const x = xKind === 'time' ? parseTime(label) : xKind === 'number' ? Number(label) : byLabel.size
      if (Number.isNaN(x)) return void skipped++
      if (xKind === 'text' && byLabel.size >= MAX_BARS) {
        truncated = true
        return void skipped++
      }
      point = { label, x, ys: ys.map(() => null) }
      byLabel.set(label, point)
    } else summed = true
    ys.forEach((col, s) => {
      const v = col[row] === null ? NaN : Number(col[row])
      if (!Number.isNaN(v)) point!.ys[s] = (point!.ys[s] ?? 0) + v
    })
  })
  const points = [...byLabel.values()]
  // Categories keep the query's order (its ORDER BY is the point); time and numbers read left to right.
  if (xKind !== 'text') points.sort((a, b) => a.x - b.x)
  return { points, summed, skipped, truncated }
}

/** Round tick values covering [min, max]: steps of 1, 2 or 5 × 10ⁿ. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) {
    const pad = Math.abs(min) || 1
    min -= pad
    max += pad
  }
  const raw = (max - min) / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw)!
  const ticks: number[] = []
  for (let v = Math.floor(min / step) * step; v <= max + step * 1e-9; v += step)
    ticks.push(Number(v.toPrecision(12)))
  if (ticks.at(-1)! < max) ticks.push(Number((ticks.at(-1)! + step).toPrecision(12)))
  return ticks
}

/** 950 · 1.3K · 12.9K · 4.2M · 0.25 */
export function compact(n: number): string {
  const a = Math.abs(n)
  if (a >= 1e9) return `${trim(n / 1e9)}B`
  if (a >= 1e6) return `${trim(n / 1e6)}M`
  if (a >= 1e3) return `${trim(n / 1e3)}K`
  return a > 0 && a < 1 ? String(Number(n.toPrecision(2))) : String(Number(n.toFixed(2)))
}

function trim(n: number) {
  return String(Number(n.toFixed(Math.abs(n) >= 100 ? 0 : 1)))
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const TIME_STEPS = [
  MINUTE,
  5 * MINUTE,
  15 * MINUTE,
  HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  7 * DAY,
  14 * DAY,
]

/** Ticks for a time axis at local-time boundaries (minutes … weeks, then months, then years). */
export function timeTicks(
  min: number,
  max: number,
  count = 6,
): { ticks: number[]; format: (t: number) => string } {
  const span = Math.max(max - min, MINUTE)
  const step = TIME_STEPS.find((s) => span / s <= count)
  if (step) {
    const d = new Date(min)
    if (step >= DAY) {
      d.setHours(0, 0, 0, 0)
      // Weeks start on Monday, like the calendar people read them in.
      if (step >= 7 * DAY) d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
    } else if (step >= HOUR) d.setHours(Math.floor(d.getHours() / (step / HOUR)) * (step / HOUR), 0, 0, 0)
    else d.setMinutes(Math.floor(d.getMinutes() / (step / MINUTE)) * (step / MINUTE), 0, 0)
    const ticks: number[] = []
    // Days step by the calendar, not by 24 h: a DST change would shift every later tick by an hour.
    const next = (t: Date) =>
      step >= DAY ? t.setDate(t.getDate() + step / DAY) : t.setTime(t.getTime() + step)
    for (; d.getTime() <= max; next(d)) if (d.getTime() >= min) ticks.push(d.getTime())
    const day = (t: number) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
    const time = (t: number) =>
      new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    return { ticks, format: step >= DAY ? day : span > DAY ? (t) => `${day(t)} ${time(t)}` : time }
  }
  const months = [1, 3, 6, 12, 24, 60, 120].find((m) => span / (m * 30 * DAY) <= count) ?? 240
  const d = new Date(min)
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  d.setMonth(Math.ceil(d.getMonth() / Math.min(months, 12)) * Math.min(months, 12))
  if (months >= 12) d.setFullYear(Math.ceil(d.getFullYear() / (months / 12)) * (months / 12), 0)
  const ticks: number[] = []
  for (; d.getTime() <= max; d.setMonth(d.getMonth() + months))
    if (d.getTime() >= min) ticks.push(d.getTime())
  return {
    ticks,
    format:
      months >= 12
        ? (t) => String(new Date(t).getFullYear())
        : (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }),
  }
}
